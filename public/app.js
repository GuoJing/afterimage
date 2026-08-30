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

const galleryDetail = document.querySelector('[data-gallery-detail]');
if (galleryDetail) initializeGalleryDetail(galleryDetail);

const editorForm = document.querySelector('[data-editor-form]');
if (editorForm) initializeEditor(editorForm);

const galleryEditor = document.querySelector('[data-gallery-editor]');
if (galleryEditor) initializeGalleryEditor(galleryEditor);

const loginForm = document.querySelector('[data-login-form]');
if (loginForm) initializeLoginForm(loginForm);

document.querySelectorAll('[data-account-form]').forEach(form => initializeAccountForm(form));
const registrationForm = document.querySelector('[data-registration-form]');
if (registrationForm) initializeRegistrationForm(registrationForm);

const guestbookAuthor = document.querySelector('[data-guestbook-author]');
if (guestbookAuthor) initializeGuestbookAuthor(guestbookAuthor);

function initializeGuestbookAuthor(input) {
  const maxWidth = Number(input.dataset.maxDisplayWidth) || 60;
  const validPattern = /^(?:[\p{L}\p{N}]\p{M}*)+$/u;
  const displayWidth = value => Array.from(value.normalize('NFKC')).reduce((width, character) => {
    if (/\p{M}/u.test(character)) return width;
    return width + (/^[\p{Script=Latin}\p{N}]$/u.test(character) ? 1 : 2);
  }, 0);
  const validate = () => {
    const value = input.value.normalize('NFKC');
    const valid = !value || (validPattern.test(value) && displayWidth(value) <= maxWidth);
    input.setCustomValidity(valid ? '' : input.dataset.invalidMessage);
  };
  input.addEventListener('input', validate);
  input.form?.addEventListener('submit', validate);
}

function initializeLoginForm(form) {
  const submit = form.querySelector('button[type="submit"]');
  const countdown = form.querySelector('[data-login-countdown]');
  let remaining = Number(form.dataset.retryAfter) || 0;
  let timer;

  const updateCountdown = () => {
    if (!countdown || remaining <= 0) {
      if (submit) submit.disabled = false;
      if (countdown) countdown.textContent = '';
      if (timer) clearInterval(timer);
      return;
    }
    if (submit) submit.disabled = true;
    countdown.textContent = `${remaining} 秒后可以重试`;
    remaining -= 1;
  };
  if (remaining > 0) {
    updateCountdown();
    timer = setInterval(updateCountdown, 1000);
  }

  form.addEventListener('submit', event => {
    if (form.dataset.submitting === '1') {
      event.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
    if (submit) {
      submit.disabled = true;
      submit.textContent = submit.dataset.submitLabel || '请稍候…';
    }
  });
}

function initializeAccountForm(form) {
  form.addEventListener('submit', event => {
    if (form.dataset.submitting === '1') {
      event.preventDefault();
      return;
    }
    form.dataset.submitting = '1';
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = submit.dataset.submitLabel || submit.textContent;
    }
  });
}

function initializeRegistrationForm(form) {
  const sendButton = form.querySelector('[data-send-registration-code]');
  const emailInput = form.querySelector('input[name="email"]');
  const csrfInput = form.querySelector('input[name="csrf"]');
  const avatarInput = form.querySelector('[data-avatar-input]');
  const avatarName = form.querySelector('[data-avatar-name]');
  const status = form.querySelector('[data-registration-code-status]');
  const storageKey = 'afterimage-registration-code-next-send';
  let nextSendAt = Date.now() + Math.max(0, Number(form.dataset.resendSeconds) || 0) * 1000;
  let timer;

  try { nextSendAt = Math.max(nextSendAt, Number(localStorage.getItem(storageKey)) || 0); } catch {}

  const renderCooldown = () => {
    const remaining = Math.max(0, Math.ceil((nextSendAt - Date.now()) / 1000));
    if (!sendButton) return;
    if (remaining > 0) {
      sendButton.disabled = true;
      sendButton.textContent = form.dataset.resendCountdown.replace('__SECONDS__', String(remaining));
      return;
    }
    sendButton.disabled = false;
    sendButton.textContent = form.dataset.resendLabel;
    if (timer) clearInterval(timer);
  };

  if (nextSendAt > Date.now()) {
    renderCooldown();
    timer = setInterval(renderCooldown, 1000);
  }

  sendButton?.addEventListener('click', async () => {
    if (!emailInput.reportValidity()) return;
    sendButton.disabled = true;
    sendButton.textContent = sendButton.dataset.sendingLabel;
    status.textContent = '';
    try {
      const response = await fetch(form.dataset.codeUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ csrf: csrfInput.value, email: emailInput.value }),
      });
      const payload = await response.json();
      status.textContent = payload.message || '';
      const retryAfter = Math.max(0, Number(payload.retryAfterSeconds) || 0);
      if (retryAfter > 0) {
        nextSendAt = Date.now() + retryAfter * 1000;
        try { localStorage.setItem(storageKey, String(nextSendAt)); } catch {}
        if (timer) clearInterval(timer);
        renderCooldown();
        timer = setInterval(renderCooldown, 1000);
      } else {
        sendButton.disabled = false;
        sendButton.textContent = form.dataset.resendLabel;
      }
    } catch {
      status.textContent = '';
      sendButton.disabled = false;
      sendButton.textContent = form.dataset.resendLabel;
    }
  });

  avatarInput?.addEventListener('change', () => {
    const file = avatarInput.files?.[0];
    if (file && file.size > 1024 * 1024) {
      avatarInput.value = '';
      status.textContent = avatarInput.closest('label')?.querySelector('small')?.textContent || '';
    }
    if (avatarName) avatarName.textContent = avatarInput.files?.[0]?.name || form.dataset.avatarEmptyLabel;
  });
}

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
            'X-File-Name': encodeURIComponent(file.name),
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

function initializeGalleryEditor(form) {
  initializeGalleryThemePicker(form);
  const list = form.querySelector('[data-gallery-photo-list]');
  const imageInput = form.querySelector('[data-gallery-image-input]');
  const uploadStatus = form.querySelector('[data-gallery-upload-status]');
  const emptyState = form.querySelector('[data-gallery-empty]');
  const count = form.querySelector('[data-gallery-photo-count]');
  const template = document.querySelector('#gallery-photo-template');
  if (!list || !imageInput || !uploadStatus || !template) return;

  let draggedPhoto = null;

  list.addEventListener('dragstart', event => {
    const card = event.target.closest('[data-gallery-photo]');
    if (!card || event.target.closest('input, textarea, button, label')) {
      event.preventDefault();
      return;
    }
    draggedPhoto = card;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragover', event => {
    if (!draggedPhoto) return;
    const target = event.target.closest('[data-gallery-photo]');
    if (!target || target === draggedPhoto) return;
    event.preventDefault();
    const cards = [...list.querySelectorAll('[data-gallery-photo]')];
    const draggedIndex = cards.indexOf(draggedPhoto);
    const targetIndex = cards.indexOf(target);
    list.insertBefore(draggedPhoto, draggedIndex < targetIndex ? target.nextSibling : target);
    refreshPhotoList();
    setStatus('顺序已调整，保存 Gallery 后生效。', 'notice');
  });

  list.addEventListener('dragend', () => {
    draggedPhoto?.classList.remove('is-dragging');
    draggedPhoto = null;
  });

  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-delete-gallery-photo]');
    if (!button) return;
    const card = button.closest('[data-gallery-photo]');
    if (!card || !window.confirm('确定从 Gallery 中移除这张照片吗？')) return;
    button.disabled = true;
    setStatus('正在移除照片…', 'uploading');
    try {
      const response = await fetch(`${form.dataset.photoDeleteBase}/${card.dataset.photoId}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: form.querySelector('[data-csrf]').value }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || '移除照片失败。');
      if (card.querySelector('[name="cover_photo_id"]')?.checked) form.querySelector('.gallery-no-cover input').checked = true;
      card.remove();
      refreshPhotoList();
      setStatus('照片已移除。', 'success');
    } catch (error) {
      button.disabled = false;
      setStatus(error.message || '移除照片失败。', 'error');
    }
  });

  imageInput.addEventListener('change', async () => {
    const images = imageFiles(imageInput.files);
    imageInput.value = '';
    if (!images.length) return;
    const maxBytes = Number(form.dataset.imageMaxBytes || 0);
    let completed = 0;
    try {
      for (const file of images) {
        if (maxBytes && file.size > maxBytes) throw new Error(`“${file.name}”超过上传大小限制。`);
        setStatus(`正在上传 ${completed + 1}/${images.length}…`, 'uploading');
        const response = await fetch(form.dataset.photoUploadUrl, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-CSRF-Token': form.querySelector('[data-csrf]').value,
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '图片上传失败。');
        appendPhoto(result, file.name);
        completed += 1;
      }
      setStatus(images.length > 1 ? `已上传 ${images.length} 张照片，保存后可记录描述和顺序。` : '照片已上传，保存后可记录描述和顺序。', 'success');
    } catch (error) {
      setStatus(error.message || '图片上传失败。', 'error');
    }
  });

  function appendPhoto(photo, filename) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.photoId = String(photo.id);
    card.querySelector('[name="photo_id"]').value = photo.id;
    const image = card.querySelector('img');
    image.src = photo.imageUrl;
    image.alt = markdownAlt(filename);
    card.querySelector('[name="cover_photo_id"]').value = photo.id;
    list.append(card);
    refreshPhotoList();
  }

  function refreshPhotoList() {
    const cards = [...list.querySelectorAll('[data-gallery-photo]')];
    cards.forEach((card, index) => { card.querySelector('[data-gallery-position]').textContent = String(index + 1); });
    count.textContent = String(cards.length);
    emptyState.hidden = cards.length > 0;
  }

  function setStatus(message, state) {
    uploadStatus.textContent = message;
    uploadStatus.className = `gallery-upload-status ${state}`;
  }
}

function initializeGalleryThemePicker(form) {
  const picker = form.querySelector('[data-gallery-theme-picker]');
  if (!picker) return;
  const choices = [...picker.querySelectorAll('[data-gallery-theme-choice]')];
  const panels = [...picker.querySelectorAll('[data-gallery-theme-panel]')];
  const badge = picker.querySelector('[data-gallery-theme-badge]');

  picker.addEventListener('change', event => {
    const input = event.target.closest('[name="gallery_theme"]');
    if (!input) return;
    selectTheme(input.value);
  });

  function selectTheme(theme) {
    choices.forEach(choice => {
      const input = choice.querySelector('[name="gallery_theme"]');
      const selected = input.value === theme;
      choice.classList.toggle('is-selected', selected);
      choice.setAttribute('aria-checked', String(selected));
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.galleryThemePanel !== theme; });
    const selectedChoice = choices.find(choice => choice.querySelector('[name="gallery_theme"]').value === theme);
    if (badge && selectedChoice) badge.textContent = selectedChoice.querySelector('strong').textContent;
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
  const images = [...document.querySelectorAll('.post-detail .prose img, [data-gallery-lightbox]')];
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

function initializeGalleryDetail(root) {
  const fadeGallery = root.querySelector('[data-fade-gallery]');
  if (fadeGallery) initializeFadeGallery(fadeGallery);
  const justifiedGallery = root.querySelector('[data-justified-gallery]');
  if (justifiedGallery) initializeJustifiedGallery(justifiedGallery);
}

function initializeFadeGallery(gallery) {
  const slides = [...gallery.querySelectorAll('[data-fade-slide]')];
  const thumbnails = [...gallery.querySelectorAll('[data-fade-thumbnail]')];
  const previous = gallery.querySelector('[data-fade-previous]');
  const next = gallery.querySelector('[data-fade-next]');
  const counter = gallery.querySelector('[data-fade-count]');
  if (!slides.length) return;

  let index = 0;
  let timer = null;
  let paused = false;
  const interval = Number(gallery.dataset.interval) || 5000;
  const autoplay = gallery.dataset.autoplay === 'true' && slides.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const show = nextIndex => {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === index;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', String(!active));
      const image = slide.querySelector('[data-gallery-lightbox]');
      if (image) image.tabIndex = active ? 0 : -1;
    });
    thumbnails.forEach((thumbnail, thumbnailIndex) => {
      const active = thumbnailIndex === index;
      thumbnail.classList.toggle('is-active', active);
      thumbnail.setAttribute('aria-current', String(active));
    });
    if (counter) counter.textContent = `${index + 1} / ${slides.length}`;
    schedule();
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (autoplay && !paused && !document.hidden) timer = window.setTimeout(() => show(index + 1), interval);
  };

  previous?.addEventListener('click', () => show(index - 1));
  next?.addEventListener('click', () => show(index + 1));
  thumbnails.forEach(thumbnail => thumbnail.addEventListener('click', () => show(Number(thumbnail.dataset.fadeThumbnail))));
  gallery.querySelector('.gallery-fade-stage')?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); }
  });
  gallery.addEventListener('mouseenter', () => { paused = true; schedule(); });
  gallery.addEventListener('mouseleave', () => { paused = false; schedule(); });
  gallery.addEventListener('focusin', () => { paused = true; schedule(); });
  gallery.addEventListener('focusout', event => {
    if (gallery.contains(event.relatedTarget)) return;
    paused = false;
    schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  if (slides.length === 1) {
    previous?.setAttribute('hidden', '');
    next?.setAttribute('hidden', '');
    counter?.setAttribute('hidden', '');
  }
  show(0);
}

function initializeJustifiedGallery(gallery) {
  const items = [...gallery.querySelectorAll('.gallery-justified-item')];
  if (!items.length) return;

  const updateRatio = item => {
    const image = item.querySelector('img');
    if (!image?.naturalWidth || !image.naturalHeight) return;
    item.dataset.photoRatio = String(image.naturalWidth / image.naturalHeight);
    layout();
  };
  const layout = () => {
    if (window.innerWidth <= 700) {
      items.forEach(item => { item.style.removeProperty('width'); item.style.removeProperty('flex'); item.style.removeProperty('--photo-height'); });
      return;
    }
    const styles = getComputedStyle(gallery);
    const width = gallery.clientWidth;
    const gap = Number.parseFloat(styles.getPropertyValue('--gallery-gap')) || 0;
    const target = Number.parseFloat(styles.getPropertyValue('--gallery-target-row-height')) || 320;
    const maxHeight = Number.parseFloat(styles.getPropertyValue('--gallery-max-row-height')) || 480;
    const rows = [];
    let row = [];
    let ratioSum = 0;
    items.forEach(item => {
      const ratio = Number(item.dataset.photoRatio) || 1.5;
      row.push({ item, ratio });
      ratioSum += ratio;
      if (ratioSum * target + gap * (row.length - 1) >= width) {
        rows.push(row);
        row = [];
        ratioSum = 0;
      }
    });
    if (row.length) rows.push(row);

    rows.forEach((entries, rowIndex) => {
      const sum = entries.reduce((total, entry) => total + entry.ratio, 0);
      const available = Math.max(1, width - gap * (entries.length - 1));
      const lastRow = rowIndex === rows.length - 1;
      const shouldFill = !lastRow || gallery.classList.contains('gallery-last-row-justify');
      const height = Math.min(maxHeight, shouldFill ? available / sum : Math.min(target, available / sum));
      entries.forEach(({ item, ratio }) => {
        const itemWidth = Math.max(1, ratio * height);
        item.style.width = `${itemWidth}px`;
        item.style.flex = `0 0 ${itemWidth}px`;
        item.style.setProperty('--photo-height', `${height}px`);
      });
    });
  };

  items.forEach(item => {
    const image = item.querySelector('img');
    if (image?.complete) updateRatio(item);
    else image?.addEventListener('load', () => updateRatio(item), { once: true });
  });
  if ('ResizeObserver' in window) new ResizeObserver(layout).observe(gallery);
  else window.addEventListener('resize', layout);
  layout();
}

function normalizeLocale(value) {
  const locale = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(locale) ? locale : '';
}
