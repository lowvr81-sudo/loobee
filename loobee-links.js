
(() => {
  "use strict";

  const BASE = "/loobee/";
  const NOT_FOUND = "https://lowvr81-sudo.github.io/404-error-not-found/";

  function handleLoobeeLink() {
    const path = decodeURIComponent(location.pathname);

    // Redirect /channels to the profile route
    if (path === BASE + "channels") {
      history.replaceState({}, "", BASE + "@yourname");
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }

    // Allow known Loobee routes
    const validRoutes = [
      BASE,
      BASE + "home",
      BASE + "channels",
      BASE + "subscriptions",
      BASE + "myvideos",
      BASE + "shorts"
    ];

    // Allow profile links such as /@yourname
    const isProfile = path.startsWith(BASE + "@") &&
      path.length > (BASE + "@").length;

    // Allow video links such as /watch/VIDEO_ID
    const isVideo = path.startsWith(BASE + "watch/") &&
      path.length > (BASE + "watch/").length;

    if (!validRoutes.includes(path) && !isProfile && !isVideo) {
      window.location.replace(NOT_FOUND);
    }
  }

  handleLoobeeLink();
})();
