// Loobee navigation links: /home, /channels, /@username
const loobeeBase = "/loobee";

function loobeeUrl(path) {
  return loobeeBase + (path.startsWith("/") ? path : "/" + path);
}

// Give navigation buttons real URLs
document.querySelectorAll("[data-page]").forEach(button => {
  const pageName = button.dataset.page;
  button.dataset.routeHref = loobeeUrl("/" + pageName);
  button.title = "Open " + pageName;
});

// Navigate using the existing Loobee router
document.addEventListener("click", event => {
  const link = event.target.closest("[data-route-href]");
  if (!link) return;

  event.preventDefault();

  const destination = link.dataset.routeHref;
  if (!destination) return;

  const path = destination.startsWith(loobeeBase)
    ? destination.slice(loobeeBase.length) || "/"
    : destination;

  history.pushState({}, "", loobeeUrl(path));
  goToPath();
});

// Support browser Back and Forward
window.addEventListener("popstate", () => {
  goToPath();
});

// Create profile links with a username
window.LoobeeProfileUrl = username =>
  loobeeUrl("/@" + encodeURIComponent(username.replace(/^@/, "")));
