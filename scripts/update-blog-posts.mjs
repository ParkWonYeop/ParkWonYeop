import { readFile, writeFile } from "node:fs/promises";

const [file = "README.md"] = process.argv.slice(2);
const API = "https://blogserver.wypark.me/api/posts?size=3";
const START = "<!-- posts:start -->";
const END = "<!-- posts:end -->";

const res = await fetch(API);
if (!res.ok) throw new Error(`${API} responded ${res.status}`);
const posts = (await res.json()).data.content;
if (!posts.length) throw new Error("no posts returned");

// Titles come from the API, so escape anything that could break the Markdown link or inject HTML.
const escapeText = (s) => s.replace(/[\\`*_[\]<>]/g, "\\$&");
const postUrl = (slug) =>
  `https://blog.wypark.me/posts/${encodeURIComponent(slug).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

const list = posts
  .map((p) => `- [${escapeText(p.title)}](${postUrl(p.slug)}) <sub>${p.createdAt.slice(0, 10).replaceAll("-", ".")}</sub>`)
  .join("\n");

const readme = await readFile(file, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end < start) throw new Error(`${file} is missing ${START} / ${END}`);

await writeFile(file, `${readme.slice(0, start + START.length)}\n${list}\n${readme.slice(end)}`);
console.log(list);
