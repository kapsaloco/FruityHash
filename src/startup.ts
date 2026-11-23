/** Finish startup before revealing a native window. Never wait for animation
 * frames here: hidden WebViews can suspend requestAnimationFrame callbacks. */
export async function prepareFirstFrame(): Promise<void> {
  if (document.readyState !== 'complete') {
    await new Promise<void>(resolve => window.addEventListener('load', () => resolve(), { once: true }));
  }
  await document.fonts.ready;
  await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
  // Resolve style and layout after mountApp sets platform/chrome and initial state.
  document.documentElement.getBoundingClientRect();
}
