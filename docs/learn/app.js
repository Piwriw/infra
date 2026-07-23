(() => {
  'use strict';

  const catalog = window.LEARNING_CATALOG;

  if (!catalog) {
    document.getElementById('page-render').innerHTML = '<div class="doc-error"><div class="error-panel"><h1>目录加载失败</h1><p>未找到学习资料目录。</p></div></div>';
    return;
  }

  const STORAGE = {
    completed: 'e2b-atlas-completed-v1',
    lastDoc: 'e2b-atlas-last-doc-v1',
    theme: 'e2b-atlas-theme'
  };

  const phaseById = new Map(catalog.phases.map(phase => [phase.id, phase]));
  const topicById = new Map(catalog.topics.map(topic => [topic.id, topic]));
  const docById = new Map(catalog.all.map(doc => [doc.id, doc]));
  const pathByUrl = new Map(catalog.all.map(doc => [normalizePath(new URL(doc.path, document.baseURI)), doc]));
  const completed = new Set(readJson(STORAGE.completed, []).filter(id => docById.has(id)));
  const sourceCache = new Map();
  const sidebarOverlayMedia = window.matchMedia('(max-width: 1120px)');

  const elements = {
    body: document.body,
    sidebar: document.getElementById('sidebar'),
    workspace: document.querySelector('.workspace'),
    skipLink: document.getElementById('skip-link'),
    contentGrid: document.querySelector('.content-grid'),
    main: document.getElementById('content'),
    page: document.getElementById('page-render'),
    rail: document.getElementById('context-rail'),
    breadcrumb: document.getElementById('breadcrumb'),
    nav: document.getElementById('course-nav'),
    progressLabel: document.getElementById('progress-label'),
    progressBar: document.getElementById('progress-bar'),
    deepCount: document.getElementById('deep-count'),
    libraryButton: document.getElementById('deep-dive-toggle'),
    themeButton: document.getElementById('theme-toggle'),
    menuButton: document.getElementById('menu-button'),
    sidebarClose: document.getElementById('sidebar-close'),
    sidebarScrim: document.getElementById('sidebar-scrim'),
    rawLink: document.getElementById('raw-link'),
    searchTrigger: document.getElementById('search-trigger'),
    searchDialog: document.getElementById('search-dialog'),
    searchInput: document.getElementById('search-input'),
    searchClose: document.getElementById('search-close'),
    searchStatus: document.getElementById('search-status'),
    searchResults: document.getElementById('search-results'),
    toast: document.getElementById('toast')
  };

  const state = {
    currentDoc: null,
    currentView: 'home',
    activeFlow: catalog.flows[0]?.id,
    libraryTopic: 'all',
    focusRouteContent: false,
    hasRenderedRoute: false,
    requestId: 0,
    tocObserver: null,
    searchGeneration: 0,
    searchIndexing: false,
    searchFailureCount: 0,
    toastTimer: null
  };

  init();

  function init() {
    configureMarkdown();
    bindEvents();
    renderNavigation();
    updateProgress();
    elements.deepCount.textContent = String(catalog.deep.length);
    syncThemeButton();
    syncSidebarState();
    handleRoute();
  }

  function configureMarkdown() {
    if (!window.marked) return;

    window.marked.setOptions({
      gfm: true,
      breaks: false,
      mangle: false,
      headerIds: false,
      highlight(code, language) {
        if (!window.hljs) return escapeHtml(code);
        const normalized = language === 'text' ? 'plaintext' : language;
        if (normalized && window.hljs.getLanguage(normalized)) {
          return window.hljs.highlight(code, { language: normalized }).value;
        }
        return window.hljs.highlightAuto(code).value;
      }
    });
  }

  function bindEvents() {
    window.addEventListener('hashchange', handleRoute);
    sidebarOverlayMedia.addEventListener('change', syncSidebarState);

    document.addEventListener('click', event => {
      const skipTarget = event.target.closest('[data-skip-content]');
      if (skipTarget) {
        event.preventDefault();
        elements.main.focus({ preventScroll: true });
        return;
      }

      const routeHome = event.target.closest('[data-route-home]');
      if (routeHome) {
        event.preventDefault();
        navigate('/', { focusContent: true });
        return;
      }

      const docTarget = event.target.closest('[data-doc-id]');
      if (docTarget) {
        if (docTarget instanceof HTMLAnchorElement && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        event.preventDefault();
        navigateToDocument(docTarget.dataset.docId, docTarget.dataset.sectionId || '', { focusContent: true });
        closeSidebar({ restoreFocus: true });
        if (elements.searchDialog.open) elements.searchDialog.close();
        return;
      }

      const flowTarget = event.target.closest('[data-flow-id]');
      if (flowTarget) {
        state.activeFlow = flowTarget.dataset.flowId;
        renderFlowConsole(flowTarget.dataset.flowId);
        return;
      }

      const pathTarget = event.target.closest('[data-path-id]');
      if (pathTarget) {
        const path = catalog.paths.find(item => item.id === pathTarget.dataset.pathId);
        if (path?.docs[0]) navigate(`/doc/${encodeURIComponent(path.docs[0])}`, { focusContent: true });
        return;
      }

      const topicTarget = event.target.closest('[data-topic-id]');
      if (topicTarget) {
        state.libraryTopic = topicTarget.dataset.topicId;
        renderLibraryList();
        return;
      }

      const completeTarget = event.target.closest('[data-toggle-complete]');
      if (completeTarget && state.currentDoc?.kind === 'core') {
        toggleComplete(state.currentDoc.id);
        return;
      }

      const retryTarget = event.target.closest('[data-retry-doc]');
      if (retryTarget && state.currentDoc) {
        state.focusRouteContent = true;
        renderDocument(state.currentDoc);
      }
    });

    elements.libraryButton.addEventListener('click', () => {
      navigate('/library', { focusContent: true });
      closeSidebar({ restoreFocus: true });
    });

    elements.themeButton.addEventListener('click', toggleTheme);
    elements.menuButton.addEventListener('click', openSidebar);
    elements.sidebarClose.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    elements.sidebarScrim.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    elements.searchTrigger.addEventListener('click', openSearch);
    elements.searchClose.addEventListener('click', () => elements.searchDialog.close());
    elements.searchDialog.addEventListener('click', event => {
      if (event.target === elements.searchDialog) elements.searchDialog.close();
    });
    elements.skipLink.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      elements.main.focus({ preventScroll: true });
    });
    elements.searchInput.addEventListener('input', () => renderSearch(elements.searchInput.value));
    elements.searchInput.addEventListener('keydown', handleSearchKeys);

    document.addEventListener('keydown', event => {
      const target = event.target;
      const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if (event.key === 'Escape' && elements.body.classList.contains('sidebar-open')) {
        event.preventDefault();
        closeSidebar({ restoreFocus: true });
      } else if (event.key === 'Tab' && elements.body.classList.contains('sidebar-open')) {
        trapSidebarFocus(event);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      } else if (!isTyping && event.key === '/') {
        event.preventDefault();
        openSearch();
      }
    });
  }

  function handleRoute() {
    const route = parseRoute(location.hash);
    closeSidebar({ restoreFocus: true });

    if (route.view === 'doc' && state.currentView === 'doc' && state.currentDoc?.id === route.id && document.getElementById('markdown-body')) {
      if (route.section) scrollToSection(route.section);
      else elements.main.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    if (state.hasRenderedRoute) state.focusRouteContent = true;
    state.hasRenderedRoute = true;

    disconnectTocObserver();
    elements.main.scrollTop = 0;

    if (route.view === 'doc') {
      const doc = docById.get(route.id);
      if (doc) {
        renderDocument(doc, route.section);
        return;
      }
      renderNotFound(route.id);
      return;
    }

    if (route.view === 'library') {
      renderLibrary();
      return;
    }

    renderHome();
  }

  function parseRoute(hash) {
    const value = hash.replace(/^#/, '');
    const queryIndex = value.indexOf('?');
    const path = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
    const query = queryIndex >= 0 ? value.slice(queryIndex + 1) : '';
    const docMatch = path.match(/^\/doc\/([^/#]+)/);
    if (docMatch) {
      const params = new URLSearchParams(query);
      return {
        view: 'doc',
        id: safeDecodeURIComponent(docMatch[1]),
        section: slugify(params.get('section') || '')
      };
    }
    if (path.startsWith('/library')) return { view: 'library' };
    return { view: 'home' };
  }

  function navigate(route, { focusContent = false } = {}) {
    if (focusContent) state.focusRouteContent = true;
    const next = `#${route}`;
    if (location.hash === next) handleRoute();
    else location.hash = next;
  }

  function consumeRouteFocus() {
    const shouldFocus = state.focusRouteContent;
    state.focusRouteContent = false;
    return shouldFocus;
  }

  function navigateToDocument(id, section = '', { focusContent = false } = {}) {
    if (state.currentView === 'doc' && state.currentDoc?.id === id) {
      if (section) scrollToSection(section, true);
      else {
        elements.main.scrollTo({ top: 0, behavior: 'smooth' });
        history.replaceState(null, '', `${location.pathname}${location.search}${buildDocumentHash(id)}`);
      }
      if (focusContent) elements.main.focus({ preventScroll: true });
      return;
    }

    navigate(buildDocumentRoute(id, section), { focusContent });
  }

  function buildDocumentRoute(id, section = '') {
    return `/doc/${encodeURIComponent(id)}${section ? `?section=${encodeURIComponent(section)}` : ''}`;
  }

  function buildDocumentHash(id, section = '') {
    return `#${buildDocumentRoute(id, section)}`;
  }

  function renderNavigation() {
    elements.nav.innerHTML = catalog.phases.map(phase => {
      const docs = catalog.core.filter(doc => doc.phase === phase.id);
      return `
        <section class="nav-phase">
          <span class="nav-phase-label">${escapeHtml(phase.label)}</span>
          ${docs.map(doc => `
            <button class="course-link${completed.has(doc.id) ? ' is-complete' : ''}" type="button" data-doc-id="${escapeAttribute(doc.id)}" aria-label="打开 ${escapeAttribute(doc.title)}">
              <span class="course-index">${String(doc.order).padStart(2, '0')}</span>
              <span class="course-title">${escapeHtml(doc.shortTitle)}</span>
              <span class="course-status" aria-hidden="true"><i data-lucide="check"></i></span>
            </button>
          `).join('')}
        </section>
      `;
    }).join('');
    updateActiveNavigation();
    refreshIcons(elements.nav);
  }

  function updateActiveNavigation() {
    elements.nav.querySelectorAll('.course-link').forEach(button => {
      button.classList.toggle('is-active', state.currentView === 'doc' && button.dataset.docId === state.currentDoc?.id);
      button.classList.toggle('is-complete', completed.has(button.dataset.docId));
    });
    elements.libraryButton.classList.toggle('is-active', state.currentView === 'library');
  }

  function renderHome() {
    const focusContent = consumeRouteFocus();
    state.currentDoc = null;
    state.currentView = 'home';
    state.requestId += 1;
    setRailVisible(false);
    elements.rawLink.classList.add('is-hidden');
    elements.breadcrumb.innerHTML = '<strong>系统地图</strong>';
    updateActiveNavigation();

    const totalMinutes = catalog.core.reduce((sum, doc) => sum + doc.duration, 0);
    const lastId = readText(STORAGE.lastDoc);
    const resumeDoc = docById.get(lastId) || catalog.core[0];
    const planeDocs = {
      control: ['api', 'auth', 'dashboard-api', 'db'],
      runtime: ['client-proxy', 'orchestrator', 'envd'],
      foundation: ['shared', 'clickhouse', 'iac', 'docker-reverse-proxy', 'nomad-nodepool-apm', 'local-dev-observability']
    };

    elements.page.innerHTML = `
      <div class="home-page">
        <section class="home-hero" aria-labelledby="home-title">
          <div>
            <p class="eyebrow">Source-guided learning map</p>
            <h1 id="home-title">E2B Infra Core Atlas</h1>
            <p class="hero-copy">从一次 Sandbox 请求出发，沿控制面、流量入口、microVM 运行时和部署观测链，建立可回到源码验证的项目心智模型。</p>
            <div class="hero-actions">
              <button class="action-button" type="button" data-doc-id="${escapeAttribute(resumeDoc.id)}">
                <i data-lucide="${lastId ? 'book-open' : 'play'}"></i>
                <span>${lastId ? `继续：${escapeHtml(resumeDoc.shortTitle)}` : '从项目全景开始'}</span>
              </button>
              <button class="action-button secondary" type="button" data-doc-id="sandbox-lifecycle">
                <i data-lucide="route"></i>
                <span>查看 Sandbox 生命周期</span>
              </button>
            </div>
          </div>
          <div class="hero-stats" aria-label="学习资料统计">
            <div class="hero-stat"><strong>${catalog.core.length}</strong><span>核心组件</span></div>
            <div class="hero-stat"><strong>${catalog.deep.length}</strong><span>深挖专题</span></div>
            <div class="hero-stat"><strong>${catalog.flows.length}</strong><span>端到端链路</span></div>
            <div class="hero-stat"><strong>${formatDuration(totalMinutes)}</strong><span>核心阅读</span></div>
          </div>
        </section>

        <figure class="identity-strip">
          <img id="identity-image" src="${currentTheme() === 'dark' ? '../../readme-assets/infra-dark.png' : '../../readme-assets/infra-light.png'}" alt="E2B Infrastructure 项目视觉标识" width="1660" height="432">
        </figure>

        <section class="home-section" aria-labelledby="planes-title">
          <div class="section-heading">
            <h2 id="planes-title">三个平面，一套运行系统</h2>
            <p>控制面决定身份、资源和生命周期；数据面承载高频沙箱流量与执行；支撑面提供协议、状态、部署和观测。</p>
          </div>
          <div class="plane-map">
            ${renderPlane('01', '控制面', '谁能创建什么、资源放到哪里、生命周期如何变化。', planeDocs.control)}
            ${renderPlane('02', '数据面', '请求怎样抵达 microVM，进程和文件怎样被操作。', planeDocs.runtime)}
            ${renderPlane('03', '支撑面', '服务怎样共享契约、保存指标并部署到真实集群。', planeDocs.foundation)}
          </div>
        </section>

        <section class="home-section" aria-labelledby="flows-title">
          <div class="section-heading">
            <h2 id="flows-title">沿真实链路理解组件</h2>
            <p>组件目录说明边界，端到端链路说明协作。选择一条链路，从每个责任交接点进入对应文档。</p>
          </div>
          <div class="flow-console" id="flow-console"></div>
        </section>

        <section class="home-section" aria-labelledby="paths-title">
          <div class="section-heading">
            <h2 id="paths-title">按问题选择阅读路径</h2>
            <p>核心速通先建地图，其余路径把组件导读与既有深度文档组合起来。</p>
          </div>
          <div class="path-grid">
            ${catalog.paths.map((path, index) => renderPathCard(path, index)).join('')}
          </div>
        </section>

        <section class="home-section" aria-labelledby="curriculum-title">
          <div class="section-heading">
            <h2 id="curriculum-title">核心组件课程</h2>
            <p>每篇先确定系统位置，再看装配、核心对象、主链路、不变量、边界与源码入口。</p>
          </div>
          <div class="curriculum">
            ${catalog.phases.map(renderCurriculumPhase).join('')}
          </div>
        </section>
      </div>
    `;

    renderFlowConsole();
    refreshIcons(elements.page);
    if (focusContent) elements.main.focus({ preventScroll: true });
  }

  function renderPlane(index, title, description, docIds) {
    return `
      <article class="plane">
        <span class="plane-index">PLANE / ${index}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
        <div class="plane-nodes">
          ${docIds.map(id => {
            const doc = docById.get(id);
            return doc ? `<button class="node-button" type="button" data-doc-id="${escapeAttribute(id)}">${escapeHtml(doc.shortTitle)}</button>` : '';
          }).join('')}
        </div>
      </article>
    `;
  }

  function renderFlowConsole(focusFlowId = '') {
    const container = document.getElementById('flow-console');
    if (!container) return;
    const active = catalog.flows.find(flow => flow.id === state.activeFlow) || catalog.flows[0];
    const iconByFlow = { create: 'box', traffic: 'network', resume: 'refresh-cw', metrics: 'activity' };
    container.innerHTML = `
      <div class="flow-tabs" role="tablist" aria-label="端到端链路">
        ${catalog.flows.map(flow => `
          <button class="flow-tab" type="button" role="tab" aria-selected="${flow.id === active.id}" data-flow-id="${escapeAttribute(flow.id)}">
            <i data-lucide="${iconByFlow[flow.id] || 'route'}"></i>
            <span>${escapeHtml(flow.label)}</span>
          </button>
        `).join('')}
      </div>
      <div class="flow-body" role="tabpanel">
        <p class="flow-description">${escapeHtml(active.description)}</p>
        <ol class="flow-steps" style="--step-count:${Math.min(active.steps.length, 6)}">
          ${active.steps.map((step, index) => `
            <li class="flow-step">
              <button type="button" data-doc-id="${escapeAttribute(step[0])}">
                <span class="flow-step-index">${String(index + 1).padStart(2, '0')}</span>
                <strong>${escapeHtml(step[1])}</strong>
                <span>${escapeHtml(step[2])}</span>
              </button>
            </li>
          `).join('')}
        </ol>
      </div>
    `;
    refreshIcons(container);
    if (focusFlowId) {
      const focusedTab = [...container.querySelectorAll('[data-flow-id]')].find(tab => tab.dataset.flowId === focusFlowId);
      focusedTab?.focus({ preventScroll: true });
    }
  }

  function renderPathCard(path, index) {
    const chain = path.docs.map(id => docById.get(id)?.shortTitle || id).join(' -> ');
    return `
      <article class="path-card">
        <span class="path-number">PATH / ${String(index + 1).padStart(2, '0')}</span>
        <h3>${escapeHtml(path.label)}</h3>
        <p>${escapeHtml(path.description)}</p>
        <div class="path-chain">${escapeHtml(chain)}</div>
        <button class="path-start" type="button" data-path-id="${escapeAttribute(path.id)}">
          <span>进入路径</span><i data-lucide="arrow-right"></i>
        </button>
      </article>
    `;
  }

  function renderCurriculumPhase(phase) {
    const docs = catalog.core.filter(doc => doc.phase === phase.id);
    return `
      <section class="curriculum-phase">
        <div class="curriculum-phase-title">${escapeHtml(phase.label)}</div>
        <div class="curriculum-list">
          ${docs.map(doc => `
            <button class="curriculum-item${completed.has(doc.id) ? ' is-complete' : ''}" type="button" data-doc-id="${escapeAttribute(doc.id)}">
              <span class="curriculum-order">${String(doc.order).padStart(2, '0')}</span>
              <span class="curriculum-name">${escapeHtml(doc.shortTitle)}</span>
              <span class="curriculum-summary">${escapeHtml(doc.summary)}</span>
              <span class="curriculum-time">${doc.duration}m</span>
              <span class="curriculum-state" aria-hidden="true"><i data-lucide="check"></i></span>
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }

  async function renderDocument(doc, initialSection = '') {
    const focusContent = consumeRouteFocus();
    state.currentDoc = doc;
    state.currentView = 'doc';
    const requestId = ++state.requestId;
    setRailVisible(true);
    updateActiveNavigation();
    elements.rawLink.classList.remove('is-hidden');
    elements.rawLink.href = new URL(doc.path, document.baseURI).href;
    elements.breadcrumb.innerHTML = `
      <span>${escapeHtml(doc.kind === 'core' ? phaseById.get(doc.phase)?.label || '核心课程' : topicById.get(doc.topic)?.label || '专题资料')}</span>
      <i data-lucide="chevron-right"></i>
      <strong>${escapeHtml(doc.shortTitle)}</strong>
    `;
    refreshIcons(elements.breadcrumb);
    writeText(STORAGE.lastDoc, doc.id);

    elements.page.innerHTML = `
      <div class="doc-loading" aria-busy="true">
        <div class="loading-panel"><div class="loading-mark" aria-hidden="true"></div><span>正在读取 ${escapeHtml(doc.shortTitle)}</span></div>
      </div>
    `;
    elements.rail.innerHTML = '';
    if (focusContent) elements.main.focus({ preventScroll: true });

    try {
      const markdown = await fetchDocument(doc);
      if (requestId !== state.requestId) return;
      const rendered = renderMarkdown(markdown);
      const phaseLabel = doc.kind === 'core' ? phaseById.get(doc.phase)?.label : topicById.get(doc.topic)?.label;
      const nav = getAdjacentCoreDocs(doc);

      elements.page.innerHTML = `
        <div class="document-page">
          <header class="doc-header">
            <div class="doc-kind"><span>${doc.kind === 'core' ? 'Core component' : 'Deep dive'}</span><span>${escapeHtml(phaseLabel || '专题')}</span></div>
            <h1>${escapeHtml(doc.title)}</h1>
            <p class="doc-summary">${escapeHtml(doc.summary)}</p>
            <div class="doc-meta-row">
              <span class="doc-meta-item"><i data-lucide="clock-3"></i>${doc.duration} 分钟</span>
              ${doc.codeRoot ? `<span class="doc-meta-item"><i data-lucide="folder-code"></i>${escapeHtml(doc.codeRoot)}</span>` : ''}
              <span class="tag-list">${doc.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>
            </div>
            <div class="doc-actions">
              ${doc.kind === 'core' ? renderCompletionButton(doc.id) : ''}
              <a class="action-button secondary" href="${escapeAttribute(new URL(doc.path, document.baseURI).href)}" target="_blank" rel="noreferrer">
                <i data-lucide="file-text"></i><span>Markdown 原文</span>
              </a>
            </div>
          </header>
          <article class="markdown-body" id="markdown-body">${rendered}</article>
          ${renderDocFooter(nav)}
        </div>
      `;

      const article = document.getElementById('markdown-body');
      removeDuplicateTitle(article);
      processDocumentContent(article, doc);
      renderContextRail(doc, article);
      refreshIcons(elements.page);
      scrollToInitialSection(initialSection);
    } catch (error) {
      if (requestId !== state.requestId) return;
      renderDocumentError(doc, error);
    }
  }

  function renderMarkdown(markdown) {
    if (!window.marked || !window.DOMPurify) {
      return `<pre><code>${escapeHtml(markdown)}</code></pre>`;
    }
    const html = window.marked.parse(markdown);
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  async function fetchDocument(doc) {
    if (sourceCache.has(doc.id)) return sourceCache.get(doc.id);
    const response = await fetch(doc.path, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    sourceCache.set(doc.id, text);
    return text;
  }

  function removeDuplicateTitle(article) {
    const firstHeading = article.querySelector('h1');
    if (firstHeading) firstHeading.remove();
  }

  function processDocumentContent(article, doc) {
    const usedIds = new Set();
    article.querySelectorAll('h2, h3, h4').forEach(heading => {
      heading.dataset.headingTitle = heading.textContent.trim();
      const base = slugify(heading.textContent) || 'section';
      let id = base;
      let suffix = 1;
      while (usedIds.has(id)) id = `${base}-${suffix++}`;
      usedIds.add(id);
      heading.id = id;
      const anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = buildDocumentHash(doc.id, id);
      anchor.setAttribute('aria-hidden', 'true');
      anchor.tabIndex = -1;
      anchor.textContent = '#';
      anchor.addEventListener('click', event => {
        event.preventDefault();
        scrollToSection(id, true);
      });
      heading.prepend(anchor);
    });

    article.querySelectorAll('table').forEach(table => {
      if (table.parentElement?.classList.contains('table-wrap')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });

    const sourceUrl = new URL(doc.path, document.baseURI);
    article.querySelectorAll('a[href]').forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (!href || anchor.classList.contains('heading-anchor')) return;
      if (/^(mailto:|tel:|javascript:)/i.test(href)) return;

      if (href.startsWith('#')) {
        const section = resolveSectionId(article, href, anchor.textContent);
        anchor.href = buildDocumentHash(doc.id, section);
        anchor.dataset.docId = doc.id;
        if (section) anchor.dataset.sectionId = section;
        return;
      }

      let resolved;
      try {
        resolved = new URL(href, sourceUrl);
      } catch (_) {
        return;
      }

      const targetDoc = resolved.origin === location.origin ? pathByUrl.get(normalizePath(resolved)) : null;
      if (targetDoc) {
        const section = normalizeSectionFragment(resolved.hash);
        anchor.href = buildDocumentHash(targetDoc.id, section);
        anchor.dataset.docId = targetDoc.id;
        if (section) anchor.dataset.sectionId = section;
        return;
      }

      anchor.href = resolved.href;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
    });

    article.querySelectorAll('img[src]').forEach(image => {
      try {
        image.src = new URL(image.getAttribute('src'), sourceUrl).href;
      } catch (_) {}
    });

    if (window.hljs) {
      article.querySelectorAll('pre code:not(.hljs)').forEach(block => window.hljs.highlightElement(block));
    }
  }

  function renderContextRail(doc, article) {
    const headings = [...article.querySelectorAll('h2, h3')];
    elements.rail.innerHTML = `
      <div class="rail-inner">
        <div class="rail-label"><span>On this page</span><span>${String(headings.length).padStart(2, '0')}</span></div>
        <div class="rail-meta">
          <div class="rail-meta-item"><span>READ</span><strong>${doc.duration} min</strong></div>
          <div class="rail-meta-item"><span>TYPE</span><strong>${doc.kind === 'core' ? 'CORE' : 'DEEP'}</strong></div>
        </div>
        <nav class="toc-list" aria-label="本文目录">
          ${headings.map(heading => `<a class="toc-link level-${heading.tagName.slice(1)}" href="${escapeAttribute(buildDocumentHash(doc.id, heading.id))}" data-toc-id="${escapeAttribute(heading.id)}">${escapeHtml(heading.dataset.headingTitle || heading.textContent.replace(/^#/, '').trim())}</a>`).join('')}
        </nav>
      </div>
    `;

    elements.rail.querySelectorAll('.toc-link').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        scrollToSection(link.dataset.tocId, true);
      });
    });

    if (!headings.length || !('IntersectionObserver' in window)) return;
    state.tocObserver = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      elements.rail.querySelectorAll('.toc-link').forEach(link => link.classList.toggle('is-active', link.dataset.tocId === visible.target.id));
    }, { root: elements.main, rootMargin: '-10% 0px -78% 0px', threshold: [0, 1] });
    headings.forEach(heading => state.tocObserver.observe(heading));
  }

  function scrollToInitialSection(section) {
    if (section) requestAnimationFrame(() => scrollToSection(section));
  }

  function scrollToSection(section, updateRoute = false) {
    const article = document.getElementById('markdown-body');
    if (!article || !state.currentDoc) return false;
    const id = resolveSectionId(article, section);
    const target = [...article.querySelectorAll('h2[id], h3[id], h4[id]')].find(heading => heading.id === id);
    if (!target) return false;

    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const mainRect = elements.main.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, elements.main.scrollTop + targetRect.top - mainRect.top - 18);
    elements.main.scrollTo({ top, behavior: updateRoute ? 'smooth' : 'auto' });
    if (updateRoute) {
      history.replaceState(null, '', `${location.pathname}${location.search}${buildDocumentHash(state.currentDoc.id, id)}`);
    }
    return true;
  }

  function disconnectTocObserver() {
    state.tocObserver?.disconnect();
    state.tocObserver = null;
  }

  function getAdjacentCoreDocs(doc) {
    if (doc.kind !== 'core') return { previous: null, next: null };
    const index = catalog.core.findIndex(item => item.id === doc.id);
    return {
      previous: index > 0 ? catalog.core[index - 1] : null,
      next: index < catalog.core.length - 1 ? catalog.core[index + 1] : null
    };
  }

  function renderDocFooter(nav) {
    if (!nav.previous && !nav.next) return '';
    return `
      <nav class="doc-footer" aria-label="上一篇和下一篇">
        ${nav.previous ? `<a class="doc-nav-link" href="#/doc/${escapeAttribute(nav.previous.id)}" data-doc-id="${escapeAttribute(nav.previous.id)}"><span>上一组件</span><strong>${escapeHtml(nav.previous.title)}</strong></a>` : '<span></span>'}
        ${nav.next ? `<a class="doc-nav-link next" href="#/doc/${escapeAttribute(nav.next.id)}" data-doc-id="${escapeAttribute(nav.next.id)}"><span>下一组件</span><strong>${escapeHtml(nav.next.title)}</strong></a>` : '<span></span>'}
      </nav>
    `;
  }

  function renderCompletionButton(id) {
    const done = completed.has(id);
    return `
      <button class="completion-button${done ? ' is-complete' : ''}" type="button" data-toggle-complete="${escapeAttribute(id)}" aria-pressed="${done}">
        <i data-lucide="${done ? 'circle-check' : 'check'}"></i>
        <span>${done ? '已完成' : '标记为已完成'}</span>
      </button>
    `;
  }

  function toggleComplete(id) {
    if (completed.has(id)) completed.delete(id);
    else completed.add(id);
    writeJson(STORAGE.completed, [...completed]);
    updateProgress();
    renderNavigation();

    if (state.currentDoc?.id === id) {
      const oldButton = elements.page.querySelector('[data-toggle-complete]');
      if (oldButton) {
        const done = completed.has(id);
        oldButton.classList.toggle('is-complete', done);
        oldButton.setAttribute('aria-pressed', String(done));
        oldButton.innerHTML = `<i data-lucide="${done ? 'circle-check' : 'check'}"></i><span>${done ? '已完成' : '标记为已完成'}</span>`;
        refreshIcons(oldButton);
      }
    }
    showToast(completed.has(id) ? '已记录阅读进度' : '已取消完成标记');
  }

  function updateProgress() {
    const count = catalog.core.filter(doc => completed.has(doc.id)).length;
    const percent = catalog.core.length ? Math.round((count / catalog.core.length) * 100) : 0;
    elements.progressLabel.textContent = `${count} / ${catalog.core.length}`;
    elements.progressBar.style.width = `${percent}%`;
  }

  function renderLibrary() {
    const focusContent = consumeRouteFocus();
    state.currentDoc = null;
    state.currentView = 'library';
    state.requestId += 1;
    setRailVisible(false);
    elements.rawLink.classList.add('is-hidden');
    elements.breadcrumb.innerHTML = '<span>学习资料</span><i data-lucide="chevron-right"></i><strong>专题资料库</strong>';
    updateActiveNavigation();

    elements.page.innerHTML = `
      <div class="library-page">
        <header class="library-header">
          <p class="eyebrow">Deep-dive reference</p>
          <h1>专题资料库</h1>
          <p>当组件导读建立了边界后，在这里按业务问题进入请求链、状态机、协议与数据模型的完整源码剖析。</p>
        </header>
        <div class="library-toolbar" role="tablist" aria-label="专题分类">
          <button class="topic-tab" type="button" role="tab" data-topic-id="all">全部 / ${catalog.deep.length}</button>
          ${catalog.topics.map(topic => `<button class="topic-tab" type="button" role="tab" data-topic-id="${escapeAttribute(topic.id)}">${escapeHtml(topic.label)}</button>`).join('')}
        </div>
        <div class="library-list" id="library-list"></div>
      </div>
    `;
    renderLibraryList();
    refreshIcons(elements.page);
    if (focusContent) elements.main.focus({ preventScroll: true });
  }

  function renderLibraryList() {
    const container = document.getElementById('library-list');
    if (!container) return;
    elements.page.querySelectorAll('.topic-tab').forEach(button => button.setAttribute('aria-selected', String(button.dataset.topicId === state.libraryTopic)));
    const topics = state.libraryTopic === 'all' ? catalog.topics : catalog.topics.filter(topic => topic.id === state.libraryTopic);
    container.innerHTML = topics.map(topic => {
      const docs = catalog.deep.filter(doc => doc.topic === topic.id);
      if (!docs.length) return '';
      return `
        <section class="library-group">
          <div class="library-group-title">${escapeHtml(topic.label)} / ${String(docs.length).padStart(2, '0')}</div>
          <div class="library-docs">
            ${docs.map(doc => `
              <button class="library-item" type="button" data-doc-id="${escapeAttribute(doc.id)}">
                <span class="library-title">${escapeHtml(doc.title)}</span>
                <span class="library-summary">${escapeHtml(doc.summary)}</span>
                <span class="library-tags">${doc.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>
                <i data-lucide="arrow-up-right"></i>
              </button>
            `).join('')}
          </div>
        </section>
      `;
    }).join('');
    refreshIcons(container);
  }

  function renderDocumentError(doc, error) {
    elements.page.innerHTML = `
      <div class="doc-error">
        <div class="error-panel">
          <h1>无法读取文档</h1>
          <p>${escapeHtml(doc.path)} · ${escapeHtml(error.message || '未知错误')}</p>
          <button class="action-button" type="button" data-retry-doc><i data-lucide="refresh-cw"></i><span>重试</span></button>
        </div>
      </div>
    `;
    elements.rail.innerHTML = '';
    refreshIcons(elements.page);
  }

  function renderNotFound(id) {
    const focusContent = consumeRouteFocus();
    state.currentDoc = null;
    state.currentView = 'not-found';
    state.requestId += 1;
    setRailVisible(false);
    elements.rawLink.classList.add('is-hidden');
    elements.breadcrumb.innerHTML = '<strong>未找到文档</strong>';
    updateActiveNavigation();
    elements.page.innerHTML = `
      <div class="doc-error">
        <div class="error-panel">
          <h1>学习文档不存在</h1>
          <p>目录中没有 “${escapeHtml(id || '')}”。</p>
          <button class="action-button" type="button" data-route-home><i data-lucide="map"></i><span>返回系统地图</span></button>
        </div>
      </div>
    `;
    refreshIcons(elements.page);
    if (focusContent) elements.main.focus({ preventScroll: true });
  }

  function setRailVisible(visible) {
    elements.contentGrid.classList.toggle('no-rail', !visible);
    elements.rail.classList.toggle('is-hidden', !visible);
    if (!visible) elements.rail.innerHTML = '';
  }

  function syncSidebarState() {
    const isOverlay = sidebarOverlayMedia.matches;
    const focusMainOnDesktop = !isOverlay && (document.activeElement === elements.menuButton || document.activeElement === elements.sidebarClose);
    if (!isOverlay) elements.body.classList.remove('sidebar-open');
    const isOpen = isOverlay && elements.body.classList.contains('sidebar-open');

    if (isOverlay && !isOpen && elements.sidebar.contains(document.activeElement)) {
      elements.menuButton.focus({ preventScroll: true });
    }

    elements.sidebar.toggleAttribute('inert', isOverlay && !isOpen);
    if (isOverlay && !isOpen) elements.sidebar.setAttribute('aria-hidden', 'true');
    else elements.sidebar.removeAttribute('aria-hidden');
    elements.workspace.toggleAttribute('inert', isOpen);
    if (isOpen) elements.workspace.setAttribute('aria-hidden', 'true');
    else elements.workspace.removeAttribute('aria-hidden');
    elements.skipLink.toggleAttribute('inert', isOpen);
    elements.menuButton.setAttribute('aria-expanded', String(isOpen));
    if (focusMainOnDesktop) elements.main.focus({ preventScroll: true });
  }

  function openSidebar() {
    if (!sidebarOverlayMedia.matches) return;
    elements.body.classList.add('sidebar-open');
    elements.sidebar.removeAttribute('inert');
    elements.sidebar.removeAttribute('aria-hidden');
    elements.sidebarClose.focus({ preventScroll: true });
    syncSidebarState();
  }

  function closeSidebar({ restoreFocus = false } = {}) {
    const wasOpen = elements.body.classList.contains('sidebar-open');
    if (wasOpen && restoreFocus) {
      elements.workspace.removeAttribute('inert');
      elements.workspace.removeAttribute('aria-hidden');
      elements.skipLink.removeAttribute('inert');
      elements.menuButton.focus({ preventScroll: true });
    } else if (wasOpen && elements.sidebar.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    elements.body.classList.remove('sidebar-open');
    syncSidebarState();
  }

  function trapSidebarFocus(event) {
    const focusable = [...elements.sidebar.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.inert && element.getClientRects().length > 0);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !elements.sidebar.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openSearch() {
    closeSidebar();
    if (!elements.searchDialog.open) elements.searchDialog.showModal();
    elements.searchInput.value = '';
    renderSearch('');
    requestAnimationFrame(() => elements.searchInput.focus());
    buildSearchIndex();
  }

  async function buildSearchIndex() {
    const generation = ++state.searchGeneration;
    const missing = catalog.all.filter(doc => !sourceCache.has(doc.id));
    state.searchIndexing = missing.length > 0;
    state.searchFailureCount = 0;
    if (!missing.length) return;

    if (elements.searchDialog.open && elements.searchInput.value.trim()) {
      renderSearch(elements.searchInput.value);
    }

    const outcomes = await Promise.allSettled(missing.map(doc => fetchDocument(doc)));
    if (generation !== state.searchGeneration) return;
    state.searchIndexing = false;
    state.searchFailureCount = outcomes.filter(outcome => outcome.status === 'rejected').length;
    if (!elements.searchDialog.open) return;
    renderSearch(elements.searchInput.value);
  }

  function renderSearch(rawQuery) {
    const query = rawQuery.trim().toLocaleLowerCase('zh-CN');
    let results;

    if (!query) {
      const lastId = readText(STORAGE.lastDoc);
      const recent = docById.get(lastId);
      results = [recent, ...catalog.core.slice(0, 5)].filter(Boolean).filter((doc, index, list) => list.findIndex(item => item.id === doc.id) === index);
      elements.searchStatus.textContent = '快速入口';
    } else {
      results = catalog.all.map(doc => {
        const metadata = `${doc.title} ${doc.shortTitle} ${doc.summary} ${doc.tags.join(' ')} ${doc.codeRoot || ''}`.toLocaleLowerCase('zh-CN');
        const body = (sourceCache.get(doc.id) || '').toLocaleLowerCase('zh-CN');
        let score = 0;
        if (doc.title.toLocaleLowerCase('zh-CN').includes(query)) score += 12;
        if (doc.tags.some(tag => tag.toLocaleLowerCase('zh-CN').includes(query))) score += 8;
        if (metadata.includes(query)) score += 5;
        if (body.includes(query)) score += 2;
        return { doc, score, snippet: createSnippet(sourceCache.get(doc.id), query) };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.doc.order - b.doc.order).slice(0, 18);
      const indexStatus = state.searchIndexing
        ? '正在建立全文索引'
        : state.searchFailureCount
          ? `${state.searchFailureCount} 篇正文暂不可用`
          : '已检索全文';
      elements.searchStatus.textContent = `${results.length} 个匹配 · ${indexStatus}`;
    }

    elements.searchResults.setAttribute('aria-busy', String(state.searchIndexing));
    elements.searchInput.removeAttribute('aria-activedescendant');
    if (!results.length) {
      elements.searchResults.innerHTML = '<div class="search-empty">没有匹配的组件、专题或源码概念。</div>';
      return;
    }

    elements.searchResults.innerHTML = results.map((item, index) => {
      const doc = item.doc || item;
      const snippet = item.snippet || doc.summary;
      return `
        <button class="search-result${index === 0 ? ' is-selected' : ''}" id="search-result-${index}" type="button" role="option" tabindex="-1" aria-selected="${index === 0}" data-doc-id="${escapeAttribute(doc.id)}">
          <span class="search-result-icon"><i data-lucide="${doc.kind === 'core' ? 'box' : 'file-search'}"></i></span>
          <span class="search-result-copy">
            <span class="search-result-title">${escapeHtml(doc.title)}</span>
            <span class="search-result-snippet">${escapeHtml(snippet)}</span>
          </span>
          <i data-lucide="arrow-right"></i>
        </button>
      `;
    }).join('');
    elements.searchInput.setAttribute('aria-activedescendant', 'search-result-0');
    refreshIcons(elements.searchResults);
  }

  function handleSearchKeys(event) {
    const results = [...elements.searchResults.querySelectorAll('.search-result')];
    if (!results.length) return;
    const selected = elements.searchResults.querySelector('.search-result.is-selected');
    let index = Math.max(0, results.indexOf(selected));

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      index = (index + 1) % results.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      index = (index - 1 + results.length) % results.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selected?.click();
      return;
    } else {
      return;
    }

    results.forEach((result, resultIndex) => {
      const isSelected = resultIndex === index;
      result.classList.toggle('is-selected', isSelected);
      result.setAttribute('aria-selected', String(isSelected));
    });
    elements.searchInput.setAttribute('aria-activedescendant', results[index].id);
    results[index].scrollIntoView({ block: 'nearest' });
  }

  function createSnippet(markdown, query) {
    if (!markdown) return '匹配标题、标签或源码路径';
    const plain = markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`#>*_|\[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const lower = plain.toLocaleLowerCase('zh-CN');
    const index = lower.indexOf(query);
    if (index < 0) return plain.slice(0, 100);
    const start = Math.max(0, index - 42);
    const end = Math.min(plain.length, index + query.length + 62);
    return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`;
  }

  function toggleTheme() {
    const current = currentTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    writeText(STORAGE.theme, next);
    syncThemeButton();
  }

  function syncThemeButton() {
    const current = currentTheme();
    const nextLabel = current === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    elements.themeButton.innerHTML = `<i data-lucide="${current === 'dark' ? 'sun' : 'moon'}"></i><span>${nextLabel}</span>`;
    elements.themeButton.title = nextLabel;
    const lightHighlight = document.getElementById('hl-light');
    const darkHighlight = document.getElementById('hl-dark');
    if (lightHighlight && darkHighlight) {
      lightHighlight.disabled = current === 'dark';
      darkHighlight.disabled = current !== 'dark';
    }
    const identityImage = document.getElementById('identity-image');
    if (identityImage) identityImage.src = current === 'dark' ? '../../readme-assets/infra-dark.png' : '../../readme-assets/infra-light.png';
    refreshIcons(elements.themeButton);
  }

  function currentTheme() {
    return document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    state.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2200);
  }

  function refreshIcons(root = document) {
    if (!window.lucide) return;
    window.lucide.createIcons({
      root,
      attrs: { 'aria-hidden': 'true' }
    });
  }

  function normalizePath(url) {
    return safeDecodeURIComponent(url.pathname).replace(/\/{2,}/g, '/').replace(/\/$/, '');
  }

  function slugify(value) {
    return value
      .trim()
      .normalize('NFC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
      .replace(/\s/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function normalizeSectionFragment(value) {
    const fragment = safeDecodeURIComponent(String(value || '').replace(/^#/, ''));
    return fragment ? slugify(fragment) : '';
  }

  function resolveSectionId(article, value, linkText = '') {
    const requested = normalizeSectionFragment(value);
    if (!requested) return '';
    const headings = [...article.querySelectorAll('h2[id], h3[id], h4[id]')];
    if (headings.some(heading => heading.id === requested)) return requested;

    const key = sectionKey(requested);
    const idMatches = headings.filter(heading => sectionKey(heading.id) === key);
    if (idMatches.length === 1) return idMatches[0].id;

    const titleKey = sectionKey(linkText);
    const titleMatches = titleKey ? headings.filter(heading => sectionKey(heading.dataset.headingTitle) === titleKey) : [];
    return titleMatches.length === 1 ? titleMatches[0].id : requested;
  }

  function sectionKey(value) {
    return safeDecodeURIComponent(String(value || ''))
      .normalize('NFC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  }

  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function formatDuration(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? `${hours}h${rest ? `${rest}m` : ''}` : `${rest}m`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function readText(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (_) {
      return '';
    }
  }

  function writeText(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }
})();
