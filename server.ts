import index from "./src/index.html";

const localMockPath = new URL("./mock.local.json", import.meta.url);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4949),
  routes: {
    "/mock.local.json": async () => {
      const file = Bun.file(localMockPath);
      return (await file.exists()) ? new Response(await file.text(), { headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 });
    },
    "/*": index,
  },
  development: { hmr: true, console: true },
});

console.log(`maxflow v2 mockup on ${server.url}`);
