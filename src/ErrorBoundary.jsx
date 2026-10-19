import { Component } from "react";

// If something in the app breaks, show a short message and a reload button
// instead of a blank white page.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("App crashed:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-loading" dir="rtl" role="alert">
        <p>משהו השתבש בטעינה.</p>
        <button type="button" className="primary-button" onClick={() => window.location.reload()}>טעינה מחדש</button>
      </main>
    );
  }
}
