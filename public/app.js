const root = document.documentElement;
const themeButton = document.querySelector('[data-theme-toggle]');
syncThemeButton();
themeButton?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('theme', next);
  syncThemeButton();
});

function syncThemeButton() {
  if (!themeButton) return;
  const isDark = root.dataset.theme === 'dark';
  themeButton.dataset.currentTheme = isDark ? 'dark' : 'light';
  themeButton.setAttribute('aria-pressed', String(isDark));
  themeButton.setAttribute('aria-label', isDark ? '当前为深色模式，切换到浅色模式' : '当前为浅色模式，切换到深色模式');
  themeButton.title = isDark ? '当前：深色模式' : '当前：浅色模式';
}

const languageMenu = document.querySelector('.language-menu');
if (languageMenu) {
  document.addEventListener('click', event => {
    if (languageMenu.open && !languageMenu.contains(event.target)) languageMenu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !languageMenu.open) return;
    languageMenu.open = false;
    languageMenu.querySelector('summary')?.focus();
  });
  languageMenu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
    languageMenu.open = false;
  }));
}

const adminLayout = document.querySelector('.admin-layout');
if (adminLayout) {
  try { adminLayout.classList.toggle('sidebar-collapsed', localStorage.getItem('admin-sidebar') === 'collapsed'); } catch {}
  document.querySelector('[data-toggle-admin-sidebar]')?.addEventListener('click', () => {
    adminLayout.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem('admin-sidebar', adminLayout.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open'); } catch {}
  });
}

document.querySelectorAll('[data-confirm]').forEach(button => {
  button.addEventListener('click', event => {
    if (!window.confirm(button.dataset.confirm)) event.preventDefault();
  });
});

initializeImageLightbox();

const editorForm = document.querySelector('[data-editor-form]');
if (editorForm) initializeEditor(editorForm);

function initializeEditor(form) {
  const tabs = form.querySelector('[data-tabs]');
  const panels = form.querySelector('[data-panels]');
  const adder = form.querySelector('[data-language-adder]');
  const localeInput = form.querySelector('[data-new-locale]');
  const languageError = form.querySelector('[data-language-error]');
  const template = document.querySelector('#translation-template');
  const detailLayout = form.querySelector('[data-editor-detail-layout]');
  const publicRoute = form.dataset.publicRoute || '/post';
  const options = new Map([...document.querySelectorAll('#all-language-options option')].map(option => [option.value.toLowerCase(), option.textContent]));
  let nextPanelId = panels.querySelectorAll('[data-panel]').length;

  const activate = panelId => {
    tabs.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === panelId));
    panels.querySelectorAll('[data-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === panelId));
    const locale = panels.querySelector(`[data-panel="${CSS.escape(panelId)}"] [data-translation-locale]`)?.value;
    const prefix = form.querySelector('[data-url-prefix]');
    if (locale && prefix) prefix.textContent = `${publicRoute}/${locale}/`;
    updateViewLink(locale);
  };

  try { detailLayout.classList.toggle('inspector-collapsed', localStorage.getItem('editor-inspector') === 'collapsed'); } catch {}
  form.querySelector('[data-toggle-editor-sidebar]').addEventListener('click', () => {
    detailLayout.classList.toggle('inspector-collapsed');
    try { localStorage.setItem('editor-inspector', detailLayout.classList.contains('inspector-collapsed') ? 'collapsed' : 'open'); } catch {}
  });

  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) activate(tab.dataset.tab);
  });

  form.querySelector('[data-add-language]').addEventListener('click', () => {
    adder.hidden = false;
    localeInput.focus();
  });
  form.querySelector('[data-cancel-language]').addEventListener('click', () => {
    adder.hidden = true;
    languageError.textContent = '';
  });
  form.querySelector('[data-confirm-language]').addEventListener('click', addLanguage);
  localeInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addLanguage();
    }
  });

  panels.addEventListener('click', event => {
    const removeButton = event.target.closest('[data-remove-language]');
    if (!removeButton) return;
    const panel = removeButton.closest('[data-panel]');
    if (panels.querySelectorAll('[data-panel]').length === 1) {
      window.alert('至少需要保留一种语言。');
      return;
    }
    const panelId = panel.dataset.panel;
    tabs.querySelector(`[data-tab="${CSS.escape(panelId)}"]`)?.remove();
    panel.remove();
    const firstTab = tabs.querySelector('[data-tab]');
    if (firstTab) activate(firstTab.dataset.tab);
  });

  panels.addEventListener('input', event => {
    if (event.target.matches('[data-markdown-input]')) schedulePreview(event.target);
  });
  panels.querySelectorAll('[data-panel]').forEach(initializeImageUpload);
  panels.querySelectorAll('[data-markdown-input]').forEach(schedulePreview);

  function addLanguage() {
    const locale = normalizeLocale(localeInput.value);
    if (!locale) {
      languageError.textContent = '请输入有效语言代码，例如 ja、fr 或 pt-BR。';
      return;
    }
    const duplicate = [...panels.querySelectorAll('[data-translation-locale]')].some(input => input.value === locale);
    if (duplicate) {
      languageError.textContent = '这个语言版本已经存在。';
      return;
    }
    const panelId = `translation-${nextPanelId++}`;
    const label = `${options.get(locale) || locale.toUpperCase()} · ${locale.toUpperCase()}`;
    const panel = template.content.firstElementChild.cloneNode(true);
    panel.dataset.panel = panelId;
    panel.querySelector('[data-translation-locale]').value = locale;
    panel.querySelector('[data-language-label]').textContent = label;
    panels.append(panel);
    initializeImageUpload(panel);

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.tab = panelId;
    tab.textContent = label;
    tabs.append(tab);
    adder.hidden = true;
    localeInput.value = '';
    languageError.textContent = '';
    activate(panelId);
    panel.querySelector('[name="translation_title"]').focus();
  }

  form.querySelector('[name="slug"]').addEventListener('input', () => {
    const activeLocale = panels.querySelector('.translation-panel.active [data-translation-locale]')?.value;
    updateViewLink(activeLocale);
  });

  function updateViewLink(locale) {
    const link = form.querySelector('[data-view-content]');
    const slug = form.querySelector('[name="slug"]').value.trim();
    if (link && locale && slug) link.href = `${publicRoute}/${encodeURIComponent(locale)}/${encodeURIComponent(slug)}`;
  }

  function schedulePreview(textarea) {
    window.clearTimeout(textarea.previewTimer);
    textarea.previewTimer = window.setTimeout(() => updatePreview(textarea), 250);
  }

  async function updatePreview(textarea) {
    const preview = textarea.closest('[data-panel]').querySelector('[data-markdown-preview]');
    if (!textarea.value.trim()) {
      preview.innerHTML = '<p class="preview-placeholder">预览会显示在这里</p>';
      return;
    }
    const params = new URLSearchParams({ csrf: form.querySelector('[data-csrf]').value, markdown: textarea.value });
    try {
      const response = await fetch(form.dataset.previewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });
      if (!response.ok) throw new Error('preview failed');
      preview.innerHTML = await response.text();
    } catch {
      preview.innerHTML = '<p class="preview-placeholder">暂时无法生成预览</p>';
    }
  }

  function initializeImageUpload(panel) {
    const source = panel.querySelector('[data-markdown-source]');
    const textarea = panel.querySelector('[data-markdown-input]');
    const input = panel.querySelector('[data-image-input]');
    if (!source || !textarea || !input) return;

    input.addEventListener('change', () => {
      uploadImages(input.files, textarea).finally(() => { input.value = ''; });
    });
    textarea.addEventListener('paste', event => {
      const images = imageFiles(event.clipboardData?.files);
      if (!images.length) return;
      event.preventDefault();
      uploadImages(images, textarea);
    });
    source.addEventListener('dragover', event => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      source.classList.add('is-dragging');
    });
    source.addEventListener('dragleave', event => {
      if (!source.contains(event.relatedTarget)) source.classList.remove('is-dragging');
    });
    source.addEventListener('drop', event => {
      source.classList.remove('is-dragging');
      const images = imageFiles(event.dataTransfer?.files);
      if (!images.length) return;
      event.preventDefault();
      uploadImages(images, textarea);
    });
  }

  async function uploadImages(files, textarea) {
    const images = imageFiles(files);
    if (!images.length) return;
    const status = textarea.closest('[data-markdown-source]').querySelector('[data-upload-status]');
    const maxBytes = Number(form.dataset.imageMaxBytes || 0);
    let completed = 0;
    status.className = 'upload-status uploading';

    try {
      for (const file of images) {
        if (maxBytes && file.size > maxBytes) throw new Error(`“${file.name}”超过上传大小限制。`);
        status.textContent = `正在上传 ${completed + 1}/${images.length}…`;
        const response = await fetch(form.dataset.imageUploadUrl, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-CSRF-Token': form.querySelector('[data-csrf]').value,
          },
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '图片上传失败，请刷新页面后重试。');
        insertMarkdownImage(textarea, result.url, file.name);
        completed += 1;
      }
      status.className = 'upload-status success';
      status.textContent = images.length > 1 ? `已上传 ${images.length} 张图片` : '图片已插入';
    } catch (error) {
      status.className = 'upload-status error';
      status.textContent = error.message || '图片上传失败';
    }
  }

  function insertMarkdownImage(textarea, url, filename) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const alt = markdownAlt(filename);
    const leading = before && !before.endsWith('\n') ? '\n\n' : '';
    const trailing = after && !after.startsWith('\n') ? '\n\n' : '\n';
    textarea.setRangeText(`${leading}![${alt}](${url})${trailing}`, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }
}

function imageFiles(fileList) {
  return [...(fileList || [])].filter(file => file.type.startsWith('image/'));
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}

function markdownAlt(filename) {
  const name = String(filename || 'image').replace(/\.[^.]+$/, '') || 'image';
  return name.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replace(/[\r\n]+/g, ' ').trim();
}

function initializeImageLightbox() {
  const images = [...document.querySelectorAll('.post-detail .prose img')];
  if (!images.length) return;

  const lightbox = document.createElement('div');
  lightbox.className = 'image-lightbox';
  lightbox.hidden = true;
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', '图片预览');

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-lightbox-close';
  closeButton.setAttribute('aria-label', '关闭图片预览');

  const previousButton = document.createElement('button');
  previousButton.type = 'button';
  previousButton.className = 'image-lightbox-nav image-lightbox-previous';
  previousButton.setAttribute('aria-label', '查看上一张图片');

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'image-lightbox-nav image-lightbox-next';
  nextButton.setAttribute('aria-label', '查看下一张图片');

  const counter = document.createElement('span');
  counter.className = 'image-lightbox-counter';
  counter.setAttribute('aria-live', 'polite');

  const preview = document.createElement('img');
  preview.alt = '';
  lightbox.append(closeButton, previousButton, preview, nextButton, counter);
  document.body.append(lightbox);

  let sourceImage = null;
  let currentIndex = 0;
  const multipleImages = images.length > 1;
  previousButton.hidden = !multipleImages;
  nextButton.hidden = !multipleImages;
  counter.hidden = !multipleImages;

  const show = index => {
    currentIndex = (index + images.length) % images.length;
    sourceImage = images[currentIndex];
    preview.src = sourceImage.currentSrc || sourceImage.src;
    preview.alt = sourceImage.alt || '';
    counter.textContent = `${currentIndex + 1} / ${images.length}`;
  };
  const open = image => {
    show(images.indexOf(image));
    lightbox.hidden = false;
    document.body.classList.add('image-lightbox-open');
    closeButton.focus();
  };
  const close = () => {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.classList.remove('image-lightbox-open');
    preview.removeAttribute('src');
    sourceImage?.focus({ preventScroll: true });
    sourceImage = null;
  };

  images.forEach(image => {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', image.alt ? `放大图片：${image.alt}` : '放大图片');
    image.addEventListener('click', event => {
      event.preventDefault();
      open(image);
    });
    image.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      open(image);
    });
  });

  closeButton.addEventListener('click', close);
  previousButton.addEventListener('click', () => show(currentIndex - 1));
  nextButton.addEventListener('click', () => show(currentIndex + 1));
  lightbox.addEventListener('click', event => {
    if (event.target === lightbox) close();
  });
  document.addEventListener('keydown', event => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft' && multipleImages) {
      event.preventDefault();
      show(currentIndex - 1);
    }
    if (event.key === 'ArrowRight' && multipleImages) {
      event.preventDefault();
      show(currentIndex + 1);
    }
  });
}

function normalizeLocale(value) {
  const locale = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale) ? locale : '';
}
