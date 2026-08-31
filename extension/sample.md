---
title: Markdown Studio sample
tags: [demo, markdown]
---

# Markdown Studio

A sample file for trying the extension. Open it from the editor's **Open file**
button, or browse to it with `file:///` once file access is enabled.

## What it covers

- **Bold**, *italic*, ***both***, ~~struck~~ and `inline code`
- [Links](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) and autolinks: <https://example.com>
- Nested lists
  - second level
    - third level
- Task lists
  - [x] read a file from disk
  - [ ] write it back

## Code

```js
async function save(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
```

## Table

| Feature | Shortcut | Works offline |
|:--------|:--------:|--------------:|
| Save | `Ctrl+S` | yes |
| Go to file | `Ctrl+P` | yes |
| Export HTML | — | yes |

> Everything renders locally. No network calls, no remote scripts.

1. Open a folder
2. Pick a file
3. Edit and save

---

Last line.
