import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./app/Home";
import { ProjectView } from "./app/ProjectView";
import "./styles.css";
import "./theme/store";

function App() {
	const [path, setPath] = useState(location.pathname);
	useEffect(() => {
		const onPop = () => setPath(location.pathname);
		addEventListener("popstate", onPop);
		return () => removeEventListener("popstate", onPop);
	}, []);
	const project = path.match(/^\/p\/([\w-]+)/)?.[1];
	return project ? <ProjectView key={project} id={project} /> : <Home />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
