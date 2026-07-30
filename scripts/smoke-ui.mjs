async function t(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  console.log(r.status, url, text.slice(0, 140).replace(/\n/g, " "));
  return { r, text };
}

await t("http://127.0.0.1:3927/ui/");
const h = await fetch("http://127.0.0.1:3927/ui/app.js");
console.log("app.js", h.status, "cache=", h.headers.get("cache-control"));
const js = await h.text();
console.log("has showBootError", js.includes("showBootError"));
await t("http://127.0.0.1:3927/api/status");
await t("http://127.0.0.1:3927/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "cn/auto",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  }),
});
const html = (await (await fetch("http://127.0.0.1:3927/ui/")).text());
console.log("abs script", html.includes('src="/ui/app.js"'), "no base", !html.includes("<base "));
console.log("auth-panels", html.includes('id="auth-panels"'));
