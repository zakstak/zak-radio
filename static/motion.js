// Move persistent elements from their previous painted positions to the new
// layout with transforms. Their DOM, focus, and visibility stay intact.
const motions = new WeakMap();
export function animateLayout(elements, update) {
  const before = new Map();
  for (const element of elements) {
    if (element.checkVisibility({ visibilityProperty: true }))
      before.set(element, element.getBoundingClientRect());
  }
  for (const element of before.keys()) motions.get(element)?.cancel();
  update();
  const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 1
    : 220;
  for (const [element, previous] of before) {
    if (
      !element.isConnected ||
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const current = element.getBoundingClientRect();
    const x = previous.left - current.left;
    const y = previous.top - current.top;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
    motions.set(
      element,
      element.animate(
        [
          { transform: `translate(${x}px, ${y}px)` },
          { transform: "translate(0, 0)" },
        ],
        { duration, easing: "ease-out" },
      ),
    );
  }
}

export const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export const seekKeys = {
  ArrowLeft: -5,
  ArrowDown: -5,
  ArrowRight: 5,
  ArrowUp: 5,
  PageDown: -30,
  PageUp: 30,
};
