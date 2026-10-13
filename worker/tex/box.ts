import { Container } from "@cloudflare/containers";

/**
 * The TeX Live container, one per project, so a project's compiles queue behind each other and
 * reuse its auxiliary files. It runs untrusted documents, so it gets no network at all.
 */
export class TexBox extends Container {
	defaultPort = 8080;
	sleepAfter = "10m";
	enableInternet = false;
}
