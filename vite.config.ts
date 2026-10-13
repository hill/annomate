import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), cloudflare()],
	server: { port: 5181 },
	worker: { format: "es" },
	optimizeDeps: {
		exclude: ["@myriaddreamin/typst-ts-web-compiler", "@myriaddreamin/typst-ts-renderer"],
	},
});
