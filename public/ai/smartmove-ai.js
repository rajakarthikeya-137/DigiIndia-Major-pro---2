(async function () {

  // 🛑 1️⃣ Prevent double initialization
  if (window.__SMARTMOVE_AI_INITIALIZED__) return;
  window.__SMARTMOVE_AI_INITIALIZED__ = true;

  /* ----------------------------
     2️⃣ Inject HTML (ONLY ONCE)
  ----------------------------- */
  if (!document.getElementById("smartmove-ai")) {
    const html = await fetch("/ai/smartmove-ai.html").then(r => r.text());
    document.body.insertAdjacentHTML("beforeend", html);
  }

  /* ----------------------------
     3️⃣ Inject CSS (ONLY ONCE)
  ----------------------------- */
  if (!document.getElementById("smartmove-ai-style")) {
    const link = document.createElement("link");
    link.id = "smartmove-ai-style";
    link.rel = "stylesheet";
    link.href = "/ai/smartmove-ai.css";
    document.head.appendChild(link);
  }

  /* ----------------------------
     4️⃣ Wire elements
  ----------------------------- */
  const fab = document.getElementById("ai-fab");
  const panel = document.getElementById("ai-panel");
  const send = document.getElementById("ai-send");
  const input = document.getElementById("ai-input");
  const chat = document.getElementById("ai-chat");

  if (!fab || !panel) return;

  /* ----------------------------
     5️⃣ Restore chat from SESSION
     (clears when browser closes)
  ----------------------------- */
  function restoreChat() {
    const saved = sessionStorage.getItem("smartmove_chat");
    if (!saved) return;

    chat.innerHTML = "";
    JSON.parse(saved).forEach(m => {
      addMsg(m.text, m.cls, false);
    });
  }

  function saveChat() {
    const msgs = [...chat.children].map(div => ({
      text: div.innerText,
      cls: div.classList.contains("user") ? "user" : "bot"
    }));
    sessionStorage.setItem("smartmove_chat", JSON.stringify(msgs));
  }

  /* ----------------------------
     6️⃣ UI helpers
  ----------------------------- */
  function addMsg(text, cls, save = true) {
    const div = document.createElement("div");
    div.className = `ai-msg ${cls}`;
    div.innerText = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    if (save) saveChat();
  }

  /* ----------------------------
     7️⃣ Bind events (ONLY ONCE)
  ----------------------------- */
  if (!fab.dataset.bound) {
    fab.onclick = () => {
      panel.style.display =
        panel.style.display === "block" ? "none" : "block";
    };
    fab.dataset.bound = "true";
  }

  if (!send.dataset.bound) {
    send.onclick = async () => {
      const question = input.value.trim();
      if (!question) return;

      addMsg("You: " + question, "user");
      input.value = "";
      addMsg("SmartMove Bharat is thinking…", "bot");

      try {
        const res = await fetch("/api/gemini/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: question })
        });

        const data = await res.json();
        chat.removeChild(chat.lastChild);
        addMsg(data.response || "No response from assistant.", "bot");

      } catch {
        chat.removeChild(chat.lastChild);
        addMsg("⚠️ Assistant unavailable.", "bot");
      }
    };
    send.dataset.bound = "true";
  }

  /* ----------------------------
     8️⃣ Restore chat at the end
  ----------------------------- */
  restoreChat();

})();
