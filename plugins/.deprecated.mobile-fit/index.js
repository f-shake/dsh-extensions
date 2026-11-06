/**
 * Host half of the mobile sidebar drawer bundle.
 *
 * The whole feature is browser-side: `client.js` registers the floating brand
 * logo into `shell.overlay` and the narrow-viewport drawer stylesheet. Nothing
 * here reaches a model request or a Host Service, so the row is a no-op.
 */
export function apply() {}
