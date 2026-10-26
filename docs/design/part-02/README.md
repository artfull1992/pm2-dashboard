# Node Control · Частина 2 — Користувачі та доступи

26.10.2026 · **Пакет для погодження**. Окремі макети USR/ACL, без змін production або репозиторію. APP-01…16, DS-01 і попередня частина не змінені.

Відкрити `gallery.html` після розпакування. В архіві `docs/design/part-02/`:

- `screens/` — 116 PNG, 24 стани у двох темах на desktop/mobile; основні таблиці, форми й ACL додатково compact/tablet та reflow 200%.
- `source/` — редагований HTML/CSS/JS-прототип і скрипти експорту/перевірки.
- `SPEC.md` — поведінка, ролі, підтвердження, помилки, обмеження self-admin, припущення API, fallback та acceptance criteria.
- `SCREEN-CATALOG.md`, `catalog.json` — вимога → ID → стан → тема → viewport → PNG.
- `QA.md`, `validation.json`, `interaction-checks.json` — перевірки макетів, не production.
- `REVIEW-STATUS.md` — межі погодження; `SHA256SUMS` — контрольні суми.

## Перегляд

Почати з USR-01, USR-02, USR-08 та ACL-04, ACL-06, ACL-09 у двох темах. У HTML працюють меню, drawer, radio/checkbox, пошук сервісів, перемикання серверів та чернетки. API-запитів немає. Save не зберігає дані; profile/logout та user list search/pagination — лише елементи макета.

Стан відкривається через `source/index.html?screen=ACL-04&theme=dark`. Відкрити локально або через звичайний static server. Галерея має всі варіанти. Не додавати цей код у production bundle.

## Відтворення

Node.js, Playwright та Chromium. `node source/render.cjs`; за потреби задати абсолютний `DESIGN_CHROMIUM_PATH`. `node source/verify.cjs` перевіряє незалежність scopes, вибір після пошуку й безпечне додавання сервера. Використати чинні залежності проєкту без їх заміни заради дизайну.

Розміри 1440×900, 1366×768, 1024×768, 390×844. 720×450 — модель reflow для 200%, не справжній browser zoom. Реальний zoom, screen reader, API/права перевіряються на реалізації. Точні email/password правила беруться з коду, не з цього прикладу.

Після погодження Codex звіряє вимоги з репозиторієм і готує промпт Claude. Не розширювати backend через поля макета. INT/RUL, PRF/AUTH і фінальна перевірка фронту залишаються наступними частинами.
