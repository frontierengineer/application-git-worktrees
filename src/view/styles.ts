export const css = `
:root {
  --changes-page: var(--frontier-color-background, #fbfaf8);
  --changes-sidebar: var(--frontier-color-surface-sunken, #f2f0ec);
  --changes-card: var(--frontier-color-surface, #ffffff);
  --changes-fill: var(--frontier-color-fill, #e9e6e0);
  --changes-text: var(--frontier-color-text, #24211d);
  --changes-muted: var(--frontier-color-text-muted, #6b665e);
  --changes-success: var(--frontier-color-success, #2b7a3d);
  --changes-warning: var(--frontier-color-warning, #8a5a00);
  --changes-danger: var(--frontier-color-danger, #b42318);
  --changes-info: var(--frontier-color-info, #2f5fb3);
  --changes-radius: var(--frontier-radius-medium, 10px);
  --changes-shadow: var(--frontier-shadow-raised, 0 1px 2px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.04));
  --changes-code: var(--frontier-font-code, ui-monospace, monospace);
}
html, body { height: 100%; }
.changes, .changes * { box-sizing: border-box; }
body { margin: 0; overflow: hidden; }
.changes { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: 100vh; }
.changes.panel { grid-template-columns: 1fr; }
.changes :where(aside, aside *, .detail, .detail *) { margin-block: 0; }
.changes aside { background: var(--changes-sidebar); display: flex; flex-direction: column; min-width: 0; }
.changes aside header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 14px; }
.changes aside h1 { font-size: 1rem; }
.changes aside ul { list-style: none; padding: 0 8px 12px; overflow-y: auto; display: grid; gap: 2px; align-content: start; flex: 1; }
.changes aside li > button { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; width: 100%; height: auto; text-align: start; padding: 8px 10px; border-radius: 8px; background: transparent; color: inherit; font-weight: inherit; }
.changes aside li > button[aria-current="true"] { background: var(--changes-card); box-shadow: var(--changes-shadow); }
.changes .entry-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.changes .entry-meta { grid-column: 1 / -1; color: var(--changes-muted); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.changes .count { font-size: 0.8em; font-weight: 600; color: var(--changes-muted); }
.changes .count[data-dirty="true"] { color: var(--changes-warning); }
.changes .detail { overflow-y: auto; padding: 18px; display: grid; gap: 18px; align-content: start; }
.changes .detail > * { max-width: 60rem; width: 100%; margin-inline: auto; }
.changes .detail header { display: grid; gap: 4px; }
.changes .detail h2 { font-size: 1.1rem; }
.changes .meta { color: var(--changes-muted); font-size: 0.9em; overflow-wrap: anywhere; }
.changes section { display: grid; gap: 8px; }
.changes h3 { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--changes-muted); }
.changes .commit { display: grid; gap: 8px; background: var(--changes-card); border-radius: var(--changes-radius); padding: 12px; box-shadow: var(--changes-shadow); }
.changes .commit textarea { width: 100%; min-height: 3.5em; resize: vertical; }
.changes .commit .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
.changes .commit .row p { flex: 1; color: var(--changes-muted); font-size: 0.85em; }
.changes details.file { background: var(--changes-card); border-radius: var(--changes-radius); }
.changes details.file > summary { display: flex; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer; }
.changes .kind { font-family: var(--changes-code); font-weight: 700; width: 1.4em; text-align: center; }
.changes .kind[data-kind="added"], .changes .kind[data-kind="untracked"] { color: var(--changes-success); }
.changes .kind[data-kind="deleted"], .changes .kind[data-kind="conflicted"] { color: var(--changes-danger); }
.changes .kind[data-kind="modified"], .changes .kind[data-kind="renamed"], .changes .kind[data-kind="copied"], .changes .kind[data-kind="type-changed"] { color: var(--changes-info); }
.changes .path { font-family: var(--changes-code); font-size: 0.9em; overflow-wrap: anywhere; flex: 1; }
.changes .file-body { padding: 0 12px 12px; display: grid; gap: 8px; }
.changes .file-actions { display: flex; justify-content: flex-end; gap: 8px; }
.changes .diff { font-family: var(--changes-code); font-size: 0.82em; background: var(--changes-page); border-radius: 8px; overflow-x: auto; padding: 6px 0; max-height: 36rem; overflow-y: auto; }
.changes .diff div { white-space: pre; padding: 0 12px; min-height: 1.4em; }
.changes .diff [data-sign="+"] { background: color-mix(in srgb, var(--changes-success) 14%, transparent); }
.changes .diff [data-sign="-"] { background: color-mix(in srgb, var(--changes-danger) 14%, transparent); }
.changes .diff [data-sign="@"] { color: var(--changes-info); }
.changes .diff [data-sign="h"] { color: var(--changes-muted); }
.changes ol.log { list-style: none; padding: 0; display: grid; gap: 4px; }
.changes ol.log li { display: flex; gap: 10px; align-items: baseline; }
.changes ol.log code { color: var(--changes-muted); }
.changes ol.log .when { color: var(--changes-muted); font-size: 0.85em; white-space: nowrap; margin-left: auto; }
.changes .message { padding: 10px 14px; border-radius: var(--changes-radius); background: var(--changes-card); }
.changes .message:empty { display: none; }
.changes .message[data-tone="danger"] { box-shadow: inset 3px 0 0 var(--changes-danger); }
.changes .message[data-tone="success"] { box-shadow: inset 3px 0 0 var(--changes-success); }
.changes .empty { margin: auto; max-width: 30rem; text-align: center; display: grid; gap: 10px; justify-items: center; padding: 32px; }
.changes .empty svg { width: 44px; height: 44px; color: var(--changes-muted); }
.changes .empty p { color: var(--changes-muted); }
.changes.panel button { min-height: 44px; }
`;

export const fallbackCss = `
body { background: var(--changes-page); color: var(--changes-text); font-family: system-ui, sans-serif; font-size: 15px; line-height: 1.5; }
button, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: none; border-radius: 8px; padding: 6px 12px; background: var(--changes-fill); }
button:disabled { opacity: 0.55; cursor: default; }
button[data-variant="primary"] { background: var(--frontier-color-primary, #5b4bc4); color: var(--frontier-color-on-primary, #fff); font-weight: 600; }
button[data-variant="ghost"] { background: transparent; color: var(--changes-muted); }
button[data-tone="danger"] { color: var(--changes-danger); }
textarea { background: var(--changes-card); border: 1px solid var(--changes-fill); border-radius: 8px; padding: 6px 10px; }
details > summary { list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: '▸'; font-size: 0.8em; }
details[open] > summary::before { content: '▾'; }
`;

export const shared = `.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }`;
