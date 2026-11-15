import index from "./src/index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4949),
  routes: { "/*": index },
  development: { hmr: true, console: true },
});

console.log(`maxflow v2 mockup on ${server.url}`);
