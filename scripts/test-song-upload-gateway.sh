#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
gateway_config="${1:-$repo_root/deploy/zak-radio.nginx.conf}"
radio_test_root="$(mktemp -d)"
cleanup() {
  if [[ -f "$radio_test_root/nginx.pid" ]]; then
    nginx -p "$radio_test_root/" -c "$radio_test_root/nginx.conf" -s quit 2>/dev/null || true
  fi
  rm -rf -- "$radio_test_root"
}
trap cleanup EXIT

read -r radio_front_port radio_auth_port radio_upstream_port < <(
  python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(3)]
for sock in sockets:
    sock.bind(('127.0.0.1', 0))
print(*(sock.getsockname()[1] for sock in sockets))
for sock in sockets:
    sock.close()
PY
)

# The actual production config runs with loopback listeners, mock SSO and a
# mock app. No production socket, identity, TLS key or data volume is opened.
sed \
  -e "s/listen 10.0.1.110:443 ssl;/listen 127.0.0.1:$radio_front_port;/g" \
  -e '/ssl_certificate/d' \
  -e "s|proxy_pass http://127.0.0.1:4183;|proxy_pass http://127.0.0.1:$radio_auth_port;|g" \
  -e "s|proxy_pass http://unix:/run/saga-kiln-https/routes.sock:;|proxy_pass http://127.0.0.1:$radio_upstream_port;|g" \
  "$gateway_config" >"$radio_test_root/gateway.conf"

cat >"$radio_test_root/nginx.conf" <<EOF
user $(id -un);
pid $radio_test_root/nginx.pid;
error_log $radio_test_root/error.log;
events {}
http {
    access_log off;
    default_type application/json;
    client_body_temp_path $radio_test_root/body;
    proxy_temp_path $radio_test_root/proxy;
    fastcgi_temp_path $radio_test_root/fastcgi;
    uwsgi_temp_path $radio_test_root/uwsgi;
    scgi_temp_path $radio_test_root/scgi;
    include $radio_test_root/gateway.conf;
    server {
        listen 127.0.0.1:$radio_auth_port;
        location / {
            if (\$http_cookie != "session=fixture") { return 401; }
            add_header X-Auth-Request-Preferred-Username fixture-user always;
            return 204;
        }
    }
    server {
        listen 127.0.0.1:$radio_upstream_port;
        location / {
            return 200 '{"path":"\$uri","method":"\$request_method","authorization":"\$http_authorization","identity":"\$http_x_zakstak_authenticated_user","cookie":"\$http_cookie"}';
        }
    }
}
EOF

nginx -t -p "$radio_test_root/" -c "$radio_test_root/nginx.conf"
nginx -p "$radio_test_root/" -c "$radio_test_root/nginx.conf"
python3 - "$radio_front_port" <<'PY'
import json
import sys
import urllib.error
import urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
base = 'http://127.0.0.1:' + sys.argv[1]
count = 0

def request(path, method='GET', headers=None, data=None, status=200):
    global count
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={'Host': 'music.home.zakstak.com', **(headers or {})})
    try:
        response = client.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        assert response.status == status, (path, method, response.status, body)
        count += 1
        return json.loads(body) if status == 200 and method != 'HEAD' else None

for path in ['/ai.json', '/.well-known/ai.json', '/api/song-upload/openapi.json']:
    assert request(path)['identity'] == ''
request('/ai.json', method='HEAD')
bearer = {'Authorization': 'Bearer zru_fixture', 'X-Zakstak-Authenticated-User': 'forged'}
for path, method in [('/api/song-upload/keys', 'GET'), ('/api/song-upload/keys', 'POST'),
                     ('/', 'GET'), ('/api/control', 'POST'), ('/api/tracks', 'GET')]:
    request(path, method, bearer, status=302)
capability = request('/api/song-upload', headers=bearer)
assert capability['authorization'] == bearer['Authorization'] and capability['identity'] == ''
upload = request('/api/tracks', 'POST', bearer, b'x' * 20000)
assert upload['method'] == 'POST' and upload['authorization'] == bearer['Authorization']
assert upload['identity'] == '' and upload['cookie'] == ''
assert request('/api/tracks', 'POST', data=b'x')['identity'] == ''
assert request('/api/song-upload')['identity'] == ''
sso = {'Cookie': 'session=fixture', 'X-Zakstak-Authenticated-User': 'forged'}
for path, method in [('/api/song-upload', 'GET'), ('/api/song-upload/keys', 'GET'), ('/api/tracks', 'POST')]:
    result = request(path, method, sso, b'x' if method == 'POST' else None)
    assert result['identity'] == 'fixture-user' and result['authorization'] == '' and result['cookie'] == ''
print(f'PASS: {count} gateway requests with isolated SSO and app fixtures')
PY
