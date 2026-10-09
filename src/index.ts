import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3008);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`revisão de vídeo em http://127.0.0.1:${info.port}`);
});
