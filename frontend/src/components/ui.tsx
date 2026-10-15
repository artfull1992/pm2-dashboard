import { type ReactNode, useId } from 'react';

// Shared page building blocks (docs/DEVELOPMENT_RULES.md, "Frontend design"). Deliberately small: one page header,
// one titled section, one status indicator. Everything else is plain markup with the shared CSS classes.

/** Page title on the left (one <h1>), its context underneath, the page's primary action on the right. */
export function PageHeader({ title, titleId, crumbs, status, meta, actions }: {
  title: string;
  titleId: string;
  crumbs?: ReactNode;
  /** Short state next to the title (e.g. a server's status). */
  status?: ReactNode;
  /** Secondary context: timestamps, refresh state, counts. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__main">
        {crumbs ? <nav className="page-header__crumbs" aria-label="Навігаційний ланцюжок">{crumbs}</nav> : null}
        <div className="page-header__title-row">
          <h1 id={titleId} className="page__title">{title}</h1>
          {status}
        </div>
        {meta ? <div className="page-header__meta">{meta}</div> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

/** A titled region (`<section aria-labelledby>`), so tests and assistive technology can address it by name. */
export function Section({ title, titleId, meta, actions, children, className }: {
  title: string;
  titleId?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const generated = useId();
  const id = titleId ?? generated;
  return (
    <section className={`section${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="section__head">
        <div>
          <h2 id={id} className="section__title">{title}</h2>
          {meta ? <p className="section__meta">{meta}</p> : null}
        </div>
        {actions ? <div className="section__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Status = coloured dot + text (colour is never the only carrier). `ok` stays quiet; `warn`/`bad` stand out;
 * `muted` is for neutral or unknown states.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export function StatusIndicator({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status--${tone}`}>{children}</span>;
}
