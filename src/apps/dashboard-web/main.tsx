import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/Toast";
import { HealthCheckProvider } from "./contexts/HealthCheckContext";
import { ThemeProvider } from "./contexts/ThemeContext";

const root = ReactDOM.createRoot(
	document.getElementById("root") as HTMLElement,
);
root.render(
	<React.StrictMode>
		<ThemeProvider>
			<ToastProvider>
				<HealthCheckProvider>
					<App />
				</HealthCheckProvider>
			</ToastProvider>
		</ThemeProvider>
	</React.StrictMode>,
);
