import { Link } from "react-router-dom";

// The two footer links on both sign-in screens. `from` rides along on the link so the
// page's Back button returns to the screen the reader left. `textClass` is separate from
// className so a screen can resize the text without two font sizes fighting in one list.
export const LegalLinks = ({ from = "/", className = "", textClass = "gap-3 text-xs" }) => (
  <nav className={`flex items-center text-slate-400 ${textClass} ${className}`} data-testid="legal-links">
    <Link to="/terms" state={{ from }} className="hover:text-slate-600" data-testid="legal-link-terms">
      Terms &amp; Conditions
    </Link>
    <span aria-hidden="true" className="text-slate-300">|</span>
    <Link to="/privacy" state={{ from }} className="hover:text-slate-600" data-testid="legal-link-privacy">
      Privacy Policy
    </Link>
  </nav>
);
