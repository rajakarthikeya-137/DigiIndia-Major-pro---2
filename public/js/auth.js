// public/js/auth.js
// Shared auth helper used by login/register/dashboard/apply pages.

const API_BASE = ""; // same-origin

/* ---------------------- API CALL WRAPPER ---------------------- */
async function apiCall(path, method = "GET", body = null, auth = false) {
  const headers = {};
  let token = localStorage.getItem("token");

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  if (auth && token) {
    headers["Authorization"] = "Bearer " + token;
  }

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.msg || data.error || "Request failed");
  return data;
}

/* ---------------------- ROLE CHECKER ---------------------- */
async function getRole() {
  try {
    const data = await apiCall("/auth/role", "GET", null, true);
    return data.role; // "admin" or "user"
  } catch {
    return null;
  }
}

/* ---------------------- TOKEN SAVE / CLEAR ---------------------- */
function saveToken(token) {
  localStorage.setItem("token", token);

  // Store cookie too (used by backend)
  document.cookie = `token=${encodeURIComponent(token)};path=/;max-age=86400`;
}

function clearToken() {
  // Clear localStorage + cookie
  localStorage.removeItem("token");
  document.cookie = `token=;path=/;max-age=0`;
}

/* ---------------------- FIXED LOGOUT (one click) ---------------------- */
function fullLogout(redirect = "/index.html") {
  clearToken();               // Clear ALL sessions
  window.location.href = redirect; // Hard redirect
}

/* ---------------------- LOGIN FORM HANDLER ---------------------- */
async function handleLoginForm(e) {
  e.preventDefault();

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const msg = document.getElementById("message");
  msg.textContent = "";

  try {
    const data = await apiCall("/auth/login", "POST", { email, password });
    saveToken(data.token);

    const nextParam = new URLSearchParams(window.location.search).get("next");
    let redirectTo = "/index.html";
    if (nextParam) redirectTo = nextParam;

    window.location.href = redirectTo;

  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------- REGISTER FORM HANDLER ---------------------- */
async function handleRegisterForm(e) {
  e.preventDefault();

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;

  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const msg = document.getElementById("message");

  msg.textContent = "";

  try {
    const data = await apiCall("/auth/signup", "POST", {
      name,
      email,
      password
    });

    saveToken(data.token);
    window.location.href = "/index.html";

  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------- LOAD USER DASHBOARD ---------------------- */
async function loadDashboard() {
  try {
    const data = await apiCall("/auth/me", "GET", null, true);
    const user = data.user;

    document.getElementById("user-name").textContent = user.name || user.email;
    document.getElementById("user-email").textContent = user.email;

  } catch (err) {
    window.location.href = "/login.html";
  }
}

/* ---------------------- OLD LOGOUT (still kept for compatibility) ---------------------- */
function logoutAndRedirect() {
  clearToken();
  window.location.href = "/login.html";
}

/* ---------------------- REQUIRE LOGIN (PROTECT PAGES) ---------------------- */
function requireLogin() {
  const token = localStorage.getItem("token");
  if (!token) {
    const next = encodeURIComponent(
      window.location.pathname + window.location.search
    );
    window.location.href = `/login.html?next=${next}`;
  }
}

/* ---------------------- UPLOAD WITH TOKEN ---------------------- */
async function fetchWithTokenFormData(url, formData) {
  const token = localStorage.getItem("token");
  const headers = {};

  if (token) headers["Authorization"] = "Bearer " + token;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: formData
  });

  return res.json();
}

/* ---------------------- EXPORT FUNCTIONS ---------------------- */
window.auth = {
  apiCall,
  saveToken,
  clearToken,
  fullLogout,           // ⭐ NEW FIXED LOGOUT
  handleLoginForm,
  handleRegisterForm,
  loadDashboard,
  logoutAndRedirect,
  requireLogin,
  fetchWithTokenFormData,
  getRole
};
