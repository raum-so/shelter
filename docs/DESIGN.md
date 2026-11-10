# Workspace interface

Shelter uses a neutral interface with locally served Geist and Geist Mono, quiet surfaces, thin borders, and color reserved for meaningful status. Light and dark modes share the same layout and semantic tokens in `apps/web/src/styles.css`.

## Shared components

- Use `PageIntro` for a page title, a short description, and its main action. Detail pages put a return link in the eyebrow and status beside the actions.
- Use the shared line tabs for sections within a page. Settings navigation follows the same treatment and keeps the active section visible on small screens.
- Compose panels with `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, and optional `CardFooter`. Standard padding is 16 px on small screens and 24 px on larger screens. Use the compact card variant for dense summaries.
- Use `FieldGroup` and `Field` for forms. The compatibility `Field` and `SelectField` exports from `components/ui.tsx` use the same field primitives. Labels, hints, validation, and disabled states must remain consistent.
- Use `Dialog` for forms and `AlertDialog` for confirmations. Both have a shared title, spacing, footer, and bounded scroll area. Long forms must remain usable on short mobile viewports.
- Use the shared status badge, alert, and empty-state components instead of creating a separate visual treatment for each feature. Status must include text, not color alone.

## Page composition

Keep the main task prominent. Secondary instructions and summaries can sit in a narrower side column on desktop and stack on mobile. Avoid stretching short forms across the entire workspace. Keep destructive actions distinct, explain their effect next to the action, and retain the existing confirmation requirements.

Supabase and settings are part of the same workspace. They use the same navigation, controls, forms, and dialogs as projects. Studio remains the full Supabase administration interface; Shelter handles installation, app connections, functions, recovery, and access.

Before changing shared components, review projects, settings, Supabase, and at least one form and confirmation dialog in both themes. Check 390 px mobile layouts and short viewports for clipping, keyboard focus, and reachable actions. Use synthetic data for screenshots and retain behavioral tests for navigation and safety boundaries; do not add tests that only assert CSS class names.
