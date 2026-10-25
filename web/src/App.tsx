export default function App() {
  return (
    <main className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <section className="welcome-panel" aria-labelledby="app-title">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <p className="eyebrow">A SOCIAL GAME OF SECRETS</p>
        <h1 id="app-title">
          Anonymous
          <span>Note.</span>
        </h1>
        <p className="welcome-copy">
          A little mystery. A lot of fun. Write something unexpected, keep it
          anonymous, and see where the room takes you.
        </p>

        <div className="foundation-status" role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>Game interface foundation is ready</span>
        </div>

        <p className="next-step">
          Room creation and joining are the next implementation step.
        </p>
      </section>

      <footer className="app-footer">
        Anonymous Note <span aria-hidden="true">·</span> Play together, stay
        anonymous
      </footer>
    </main>
  );
}