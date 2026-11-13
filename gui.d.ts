// Vite `?inline` CSS imports: the module default-exports the CSS as a string.
declare module "*.css?inline" {
  const css: string
  export default css
}
