declare module "wouter" {
	import { ReactNode } from "react";

	export function Route(props: {
		path: string;
		children: ReactNode | (() => ReactNode);
	}): JSX.Element;
	export function Switch(props: { children: ReactNode }): JSX.Element;
	export function Link(props: {
		href: string;
		children: ReactNode;
		className?: string;
	}): JSX.Element;
	export function useRoute(pattern: string): [boolean, object | null];
	export function useLocation(): [string, (path: string) => void];
	export function useSearchParams(): [
		URLSearchParams,
		(
			params: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
			options?: { replace?: boolean },
		) => void,
	];
}
