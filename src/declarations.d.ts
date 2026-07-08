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
