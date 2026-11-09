package application

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"zak-radio/internal/httpguard"
)

const (
	maxSongUploadKeys     = 1000
	maxUserSongUploadKeys = 5
	defaultSongKeyDays    = 30
	maxSongKeyDays        = 90
	secondsPerDay         = 86400
	songUploadKeyPrefix   = "zru_"
	songUploadKeyScope    = "songs:write"
	// Kept with the retained schema definition so validation uses the same SQL.
	songUploadKeysSchema = `create table song_upload_keys (
 id text primary key not null check(length(id)=32 and id not glob '*[^0-9a-f]*'),
 token_hash text not null unique check(length(token_hash)=64 and token_hash not glob '*[^0-9a-f]*'),
 owner_hash text not null check(length(owner_hash)=64 and owner_hash not glob '*[^0-9a-f]*'),
 name text not null check(length(name) between 1 and 80),
 created_at integer not null check(created_at>=0),
 expires_at integer not null check(expires_at>created_at)
 )`
)

type songUploadKey struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Scope     string `json:"scope"`
	CreatedAt int64  `json:"created_at"`
	ExpiresAt int64  `json:"expires_at"`
}

func addSongUploadKeys(ctx context.Context, tx *sql.Tx) error {
	// Canonical schema validation rejects conflicting existing definitions.
	statement := strings.Replace(songUploadKeysSchema, "create table", "create table if not exists", 1)
	_, err := tx.ExecContext(ctx, statement)
	return err
}

func songUploadKeyIntegrity(ctx context.Context, q queryer) error {
	var invalid int
	err := q.QueryRowContext(ctx, `select
 (select count(*) from song_upload_keys where
 typeof(id)<>'text' or length(cast(id as blob))<>32 or id glob '*[^0-9a-f]*' or
 typeof(token_hash)<>'text' or length(cast(token_hash as blob))<>64 or token_hash glob '*[^0-9a-f]*' or
 typeof(owner_hash)<>'text' or length(cast(owner_hash as blob))<>64 or owner_hash glob '*[^0-9a-f]*' or
 typeof(name)<>'text' or length(name) not between 1 and 80 or length(cast(name as blob))>320 or instr(name,char(0))>0 or
 typeof(created_at)<>'integer' or created_at<0 or created_at>? or
 typeof(expires_at)<>'integer' or expires_at<=created_at or expires_at>? or
 expires_at-created_at>?) +
 (case when (select count(*) from song_upload_keys)>? then 1 else 0 end) +
 (select count(*) from (select owner_hash from song_upload_keys group by owner_hash having count(*)>?))`,
		maxRetainedTimestamp, maxRetainedTimestamp, maxSongKeyDays*secondsPerDay, maxSongUploadKeys, maxUserSongUploadKeys).Scan(&invalid)
	if err != nil {
		return err
	}
	if invalid != 0 {
		return errors.New("retained song upload keys exceed type, value, or cardinality budgets")
	}
	rows, err := q.QueryContext(ctx, `select name from song_upload_keys`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if !validSongText(name, false) || strings.TrimSpace(name) != name {
			return errors.New("retained song upload key name is invalid")
		}
	}
	return rows.Err()
}

func hasSongUploadBearer(r *http.Request) bool {
	for _, value := range r.Header.Values("Authorization") {
		fields := strings.Fields(value)
		if len(fields) >= 2 && strings.EqualFold(fields[0], "Bearer") && strings.HasPrefix(strings.ToLower(fields[1]), songUploadKeyPrefix) {
			return true
		}
	}
	return false
}

// API keys grant only this upload capability. They cannot mint or revoke keys,
// and do not become browser SSO identities or station controller tokens.
func (a *App) canUploadSong(r *http.Request) (bool, error) {
	if a.cfg.UploadIdentityHeader == "" {
		return false, nil
	}
	if len(r.Header.Values("Authorization")) == 0 {
		return a.songUploadUser(r) != "", nil
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false, nil
	}
	fields := strings.Fields(values[0])
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		return false, nil
	}
	token := fields[1]
	if len(token) != len(songUploadKeyPrefix)+64 || !strings.HasPrefix(token, songUploadKeyPrefix) || !sha256Pattern.MatchString(token[len(songUploadKeyPrefix):]) {
		return false, nil
	}
	var found int
	err := a.db.QueryRowContext(r.Context(), `select 1 from song_upload_keys where token_hash=? and expires_at>?`, tokenHash(token), time.Now().Unix()).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (a *App) songUploadKeys(w http.ResponseWriter, r *http.Request) {
	user := a.songUploadUser(r)
	if user == "" || len(r.Header.Values("Authorization")) != 0 {
		httpguard.Error(w, r, http.StatusUnauthorized, "sign_in_required", "Sign in to create, list, or revoke upload keys.")
		return
	}
	owner := tokenHash(user)
	if r.Method == http.MethodDelete {
		id := strings.TrimPrefix(r.URL.Path, "/api/song-upload/keys/")
		if len(id) != 32 || !catalogIDPattern.MatchString(id) {
			httpguard.Error(w, r, 404, "key_not_found", "Upload key not found.")
			return
		}
		result, err := a.db.ExecContext(r.Context(), `delete from song_upload_keys where id=? and owner_hash=?`, id, owner)
		if err != nil {
			httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
			return
		}
		count, err := result.RowsAffected()
		if err != nil {
			httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
			return
		}
		if count == 0 {
			httpguard.Error(w, r, 404, "key_not_found", "Upload key not found.")
			return
		}
		writeJSON(w, map[string]any{"revoked": true, "id": id})
		return
	}
	if r.Method == http.MethodGet {
		rows, err := a.db.QueryContext(r.Context(), `select id,name,created_at,expires_at from song_upload_keys where owner_hash=? and expires_at>? order by created_at desc,id`, owner, time.Now().Unix())
		if err != nil {
			httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
			return
		}
		defer func() { _ = rows.Close() }()
		keys := []songUploadKey{}
		for rows.Next() {
			key := songUploadKey{Scope: songUploadKeyScope}
			if scanErr := rows.Scan(&key.ID, &key.Name, &key.CreatedAt, &key.ExpiresAt); scanErr != nil {
				httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
				return
			}
			keys = append(keys, key)
		}
		if err := rows.Err(); err != nil {
			httpguard.Error(w, r, 500, "storage_unavailable", "Key storage is unavailable.")
			return
		}
		writeJSON(w, map[string]any{"keys": keys, "max_keys": maxUserSongUploadKeys})
		return
	}
	var request struct {
		ExpiresInDays *int   `json:"expires_in_days"`
		Name          string `json:"name"`
	}
	if !httpguard.DecodeJSON(w, r, &request, false) {
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	days := defaultSongKeyDays
	if request.ExpiresInDays != nil {
		days = *request.ExpiresInDays
	}
	if request.Name == "" || utf8.RuneCountInString(request.Name) > 80 || !validSongText(request.Name, false) || days < 1 || days > maxSongKeyDays {
		httpguard.Error(w, r, 400, "invalid_key_request", "Use a name of 1–80 characters and an expiry of 1–90 days.")
		return
	}
	key, token, status, err := a.createSongUploadKey(r.Context(), owner, request.Name, days)
	if err != nil {
		if status == 500 {
			httpguard.Error(w, r, status, "storage_unavailable", "Key storage is unavailable.")
		} else {
			httpguard.Error(w, r, status, "key_limit", err.Error())
		}
		return
	}
	writeJSONStatus(w, http.StatusCreated, map[string]any{"key": key, "token": token})
}

func (a *App) createSongUploadKey(ctx context.Context, owner, name string, days int) (songUploadKey, string, int, error) {
	fail := func(err error) (songUploadKey, string, int, error) { return songUploadKey{}, "", 500, err }
	id, err := randomHex(16)
	if err != nil {
		return fail(err)
	}
	secret, err := randomHex(32)
	if err != nil {
		return fail(err)
	}
	token := songUploadKeyPrefix + secret
	now := time.Now().Unix()
	key := songUploadKey{ID: id, Name: name, Scope: songUploadKeyScope, CreatedAt: now, ExpiresAt: now + int64(days)*secondsPerDay}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return fail(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `delete from song_upload_keys where expires_at<=?`, now); err != nil {
		return fail(err)
	}
	var total, own int
	if err = tx.QueryRowContext(ctx, `select count(*),coalesce(sum(owner_hash=?),0) from song_upload_keys`, owner).Scan(&total, &own); err != nil {
		return fail(err)
	}
	if total >= maxSongUploadKeys || own >= maxUserSongUploadKeys {
		return songUploadKey{}, "", 429, fmt.Errorf("upload key limit reached; revoke an existing key before creating another")
	}
	if _, err = tx.ExecContext(ctx, `insert into song_upload_keys(id,token_hash,owner_hash,name,created_at,expires_at) values(?,?,?,?,?,?)`, id, tokenHash(token), owner, name, key.CreatedAt, key.ExpiresAt); err != nil {
		return fail(err)
	}
	if err = tx.Commit(); err != nil {
		return fail(err)
	}
	return key, token, 201, nil
}
