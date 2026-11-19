// What the Design System has no element for: the arrangement of this screen,
// in its tokens. Everything else (controls, cards, badges, the split, the
// tree, messages, tables) is drawn by the Design System itself.
export const css = `
html, body { block-size: 100%; margin: 0; }
.changes { block-size: 100vh; }
.changes .workspaces { background: var(--frontier-color-surface-sunken); }
.changes .entry { display: flex; align-items: center; gap: var(--frontier-space-2); }
.changes .entry-title { flex: 1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
.changes.compact > * { block-size: 100%; }
.changes .detail { max-inline-size: 60rem; }
.changes details.file > summary { display: flex; align-items: center; gap: var(--frontier-space-2); min-inline-size: 0; }
.changes .path { font-family: var(--frontier-font-code); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-inline-size: 0; }
.changes .path .directory { color: var(--frontier-color-text-muted); }
.changes .diff { margin: 0; max-block-size: 36rem; overflow: auto; }
.changes .diff span { display: block; padding-inline: var(--frontier-space-3); white-space: pre; min-block-size: 1lh; }
.changes .diff [data-sign="+"] { color: var(--frontier-color-success); background: color-mix(in srgb, var(--frontier-color-success) 10%, transparent); }
.changes .diff [data-sign="-"] { color: var(--frontier-color-danger); background: color-mix(in srgb, var(--frontier-color-danger) 10%, transparent); }
.changes .diff [data-sign="@"] { color: var(--frontier-color-info); }
.changes .diff [data-sign="h"] { color: var(--frontier-color-text-muted); }
.changes .log td:last-child { white-space: nowrap; }
.changes.compact .log :is(th, td):nth-child(3) { display: none; }
.visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
