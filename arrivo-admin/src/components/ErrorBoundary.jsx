import { Component } from "react";

// Catches uncaught render errors anywhere in its children so one bad page
// (a null-ref, a bad API shape, whatever) can't take down the whole
// dashboard with a blank white screen. Wraps only the page-content area in
// App.jsx, not the sidebar, so navigation still works and the admin can
// switch to a different tab to recover.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("Uncaught error in page content:", error, info);
  }

  componentDidUpdate(prevProps) {
    // Reset once the admin navigates away and back (resetKey changes),
    // otherwise switching tabs would keep showing the fallback forever.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="empty-state" style={{ color: "var(--coral)" }}>
          Something went wrong on this page — try switching tabs and back.
        </div>
      );
    }
    return this.props.children;
  }
}
