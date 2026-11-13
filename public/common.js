const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
};

const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const colorFor = (name) => {
  const palette = ['#ff7a59', '#2ec4b6', '#ffbf47', '#7aa2ff', '#ff5d8f', '#6ee7a8', '#c792ea'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
};

const avatar = (name) => `<span class="avatar" style="background: ${colorFor(name)}">${esc(name[0])}</span>`;

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

let ME = null;

async function renderTopbar(active) {
  ME = (await api('/api/me')).user;
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <a class="logo" href="/"><mark>▶</mark><span>Stream<b>Lab</b></span></a>
    <nav>
      <a href="/" class="${active === 'home' ? 'active' : ''}">Explorar</a>
      ${ME ? `<a href="/?tab=following" class="${active === 'following' ? 'active' : ''}">Siguiendo</a>
              <a href="/dashboard.html" class="${active === 'dash' ? 'active' : ''}">Mi canal</a>` : ''}
    </nav>
    <div class="spacer"></div>
    <div class="userbox">
      ${ME ? `<a href="/c/${ME.username}" title="Ver mi canal">${avatar(ME.username)}</a><b>${esc(ME.username)}</b><button class="btn ghost" id="logout">Salir</button>`
           : `<a class="btn ghost" href="/login.html">Iniciar sesión</a><a class="btn" href="/login.html#register">Registrarse</a>`}
    </div>
  `;
  document.body.prepend(bar);
  bar.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    location.href = '/';
  });
  return ME;
}

async function renderSidebar(el) {
  const list = await api('/api/channels');
  el.innerHTML = `<h4>Canales</h4>` + list.slice(0, 12).map((c) => `
    <a class="side-item" href="/c/${c.username}">
      ${avatar(c.username)}
      <span class="meta"><div class="name">${esc(c.username)}</div><div class="cat">${c.is_live ? esc(c.category) : 'Desconectado'}</div></span>
      ${c.is_live ? `<span class="dot"></span><small>${c.viewers}</small>` : `<span class="dot off"></span>`}
    </a>
  `).join('');
}

function cardHTML(c) {
  return `
    <a class="card" href="/c/${c.username}">
      <div class="thumb">
        ${c.is_live ? `<img src="${c.thumb}" onerror="this.remove()">` : ''}
        <div class="ph" style="${c.is_live ? 'z-index:-1' : ''}">${esc(c.username)}</div>
        <span class="badge ${c.is_live ? '' : 'offline'}">${c.is_live ? 'EN VIVO' : 'OFFLINE'}</span>
        ${c.is_live ? `<span class="views">${c.viewers} espectadores</span>` : ''}
      </div>
      <div class="info">
        ${avatar(c.username)}
        <div style="min-width:0">
          <div class="title">${esc(c.title)}</div>
          <div class="who">${esc(c.username)} · ${c.followers} seguidores</div>
          <div class="cat">${esc(c.category)}</div>
        </div>
      </div>
    </a>
  `;
}
