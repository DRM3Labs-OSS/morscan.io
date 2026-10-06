declare module "mustache" {
	const Mustache: { render(template: string, view: Record<string, unknown>): string };
	export default Mustache;
}
declare module "*.mustache" {
	const content: string;
	export default content;
}
declare module "*.txt" {
	const content: string;
	export default content;
}

// public-health.allow rides the bundle as text (wrangler.toml, the Text rule for **/*.allow).
declare module "*.allow" {
	const text: string;
	export default text;
}
