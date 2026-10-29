(() => {
  "use strict";

  const BASE = "/loobee";

  const routes = {
    home: "/home",
    channels: "/channels",
    subscriptions: "/subscriptions",
    myvideos: "/myvideos",
    shorts: "/shorts",
    warnings: "/warnings"
  };

  function getAppPath() {
    const path = location.pathname;

    if (path.startsWith(BASE + "/")) {
      return path.slice(BASE.length);
    }

    return path === BASE ? "/" : path;
  }

  function navigate(path) {
    const url = BASE + (path.startsWith("/") ? path : "/" + path);
    history.pushState({}, "", url);
    handleRoute();
  }

  function handleRoute() {
    const path = getAppPath();

    // Video route: /loobee/watch/VIDEO_ID
    if (path.startsWith("/watch/")) {
      const videoId = decodeURIComponent(path.slice(7));

      if (videoId) {
        if (typeof window.openVideo === "function") {
          window.openVideo(videoId);
        } else {
          document.dispatchEvent(
            new CustomEvent("loobee:navigate", {
              detail: { type: "video", id: videoId, path }
            })
          );
        }
      }
      return;
    }

    // Profile route: /loobee/@username
    if (path.startsWith("/@")) {
      const username = decodeURIComponent(path.slice(2));

      document.dispatchEvent(
        new CustomEvent("loobee:navigate", {
          detail: { type: "profile", username, path }
        })
      );
      return;
    }

    const page = path.replace(/^\/+/, "").toLowerCase() || "home";

    if (routes[page]) {
      document.dispatchEvent(
        new CustomEvent("loobee:navigate", {
          detail: { type: "page", page, path }
        })
      );
    }
  }

  // Navigation buttons using data-page="home", "channels", etc.
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-page]");

    if (button && routes[button.dataset.page]) {
      event.preventDefault();
      navigate(routes[button.dataset.page]);
      return;
    }

    // Links using href="/loobee/channels" or similar.
    const link = event.target.closest("a[href]");
    if (!link) return;

    const url = new URL(link.href, location.origin);

    if (url.origin !== location.origin) return;
    if (!url.pathname.startsWith(BASE + "/")) return;

    event.preventDefault();
    history.pushState({}, "", url.pathname + url.search + url.hash);
    handleRoute();
  });

  // Browser back and forward.
  window.addEventListener("popstate", handleRoute);

  // Make the helper available to the rest of the app.
  window.LoobeeLinks = {
    navigate,
    handleRoute,
    routes
  };

  // Start at the current URL.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleRoute, {
      once: true
    });
  } else {
    handleRoute();
  }
})();
