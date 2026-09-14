const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const { recipes: BASE_RECIPES, ingredients: CATALOG, ingredientGroups: INGREDIENT_GROUPS } = window.MIXLAB_DATA;
const STORAGE_KEY = 'mixlab-state-v2';
const LEGACY_KEY = 'mixlab-state-v1';
const DEFAULT_PANTRY = ['白朗姆','金酒','龙舌兰','伏特加','柠檬汁','青柠汁','苏打水','汤力水','可乐','柠檬气泡水'];
const TASTE_AXES = [
  ['sweet','甜度','干爽','甜润'], ['sour','酸度','柔和','明亮'], ['bitter','苦度','无苦','明显'],
  ['alcohol','酒感','轻盈','强劲'], ['aroma','香气','内敛','饱满']
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

function initialState() {
  return {
    version: 2,
    pantry: clone(DEFAULT_PANTRY),
    customIngredients: [],
    customRecipes: [],
    sessions: [],
    versions: [],
    favorites: [],
    legacySummary: {},
    view: 'discover',
    pantryGroup: '全部',
    pantryParent: '全部',
    pantryQuery: '',
    pantryPositions: {},
    pantryNavScroll: { groups:0, parents:{} },
    uiPositions: { pages:{}, scrollers:{}, dialogs:{} },
    updateSettings: { autoUpdate:true, lastCheckedAt:'' },
    recipeFilters: { query:'', mode:'all', selected:[], families:[], difficulty:[], strength:[], favoritesOnly:false }
  };
}

function migrateLegacy(old) {
  const next = initialState();
  if (!old || typeof old !== 'object') return next;
  next.pantry = Array.isArray(old.pantry) ? old.pantry : next.pantry;
  next.customIngredients = Array.isArray(old.customIngredients) ? old.customIngredients : [];
  next.customRecipes = (old.customRecipes || []).map((recipe) => ({ ...recipe, custom:true, family:'我的配方', description:recipe.notes || '早期版本中保存的个人配方。' }));
  next.favorites = Array.isArray(old.favorites) ? old.favorites : [];
  Object.entries(old.logs || {}).forEach(([id, log]) => {
    next.legacySummary[id] = { count:Number(log?.count || 0), lastMade:log?.lastMade || '', rating:Number(old.ratings?.[id] || 0), review:old.reviews?.[id] || '' };
  });
  return next;
}

function loadState() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (current?.version === 2) {
      const merged = { ...initialState(), ...current, recipeFilters:{ ...initialState().recipeFilters, ...(current.recipeFilters || {}) }, updateSettings:{ ...initialState().updateSettings, ...(current.updateSettings || {}) }, pantryNavScroll:{ ...initialState().pantryNavScroll, ...(current.pantryNavScroll || {}), parents:{ ...(current.pantryNavScroll?.parents || {}) } }, uiPositions:{ ...initialState().uiPositions, ...(current.uiPositions || {}), pages:{ ...(current.uiPositions?.pages || {}) }, scrollers:{ ...(current.uiPositions?.scrollers || {}) }, dialogs:{ ...(current.uiPositions?.dialogs || {}) } } };
      if (merged.pantryGroup === '利口酒与开胃酒') merged.pantryGroup = '利口酒';
      merged.customIngredients = merged.customIngredients.map((item)=>item.group === '利口酒与开胃酒' ? { ...item, group:'利口酒' } : item);
      Object.entries(merged.pantryPositions || {}).forEach(([key,value])=>{ const pageKey=`view:pantry:${key}`; if(!Object.prototype.hasOwnProperty.call(merged.uiPositions.pages,pageKey))merged.uiPositions.pages[pageKey]={y:Number(value?.y||0)}; });
      if(!Object.prototype.hasOwnProperty.call(merged.uiPositions.scrollers,'pantry-groups'))merged.uiPositions.scrollers['pantry-groups']={left:Number(merged.pantryNavScroll.groups||0),top:0};
      Object.entries(merged.pantryNavScroll.parents || {}).forEach(([group,left])=>{ const key=`pantry-parents:${group}`; if(!Object.prototype.hasOwnProperty.call(merged.uiPositions.scrollers,key))merged.uiPositions.scrollers[key]={left:Number(left||0),top:0}; });
      return merged;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    const migrated = migrateLegacy(legacy);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch { return initialState(); }
}

let state = loadState();
let toastTimer;
let deferredInstallPrompt = null;
let pendingConfirm = null;
let updateView = { native:false, status:'idle', message:'', progress:0, appInfo:null, available:null };
const main = $('#appMain');
const toast = $('#toast');
const dialogs = () => $$('dialog[open]');
const ingredientMap = new Map(CATALOG.map((item) => [item.name, item]));

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
let interfaceSaveTimer;
let positionRestoreToken = 0;
let restoringInterfacePosition = false;
const hasOwn = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
function scheduleInterfaceSave() { clearTimeout(interfaceSaveTimer); interfaceSaveTimer=setTimeout(saveState,160); }
function windowScrollY() { return Math.max(0,window.scrollY||document.documentElement.scrollTop||0); }
function rememberNamedScroller(element) {
  const key=element?.dataset?.scrollKey; if(!key)return;
  state.uiPositions.scrollers[key]={left:Math.max(0,element.scrollLeft||0),top:Math.max(0,element.scrollTop||0)};
}
function rememberNamedScrollers(root=document) { $$('[data-scroll-key]',root).forEach(rememberNamedScroller); }
function restoreNamedScrollers(root=document) {
  $$('[data-scroll-key]',root).forEach((element)=>{ const saved=state.uiPositions.scrollers[element.dataset.scrollKey]; if(!saved)return; element.scrollLeft=Number(saved.left||0); element.scrollTop=Number(saved.top||0); });
}
function rememberRenderedPagePosition() {
  const key=main.dataset.positionKey; const y=windowScrollY();
  if(key)state.uiPositions.pages[key]={y};
  rememberNamedScrollers(main); scheduleInterfaceSave(); return y;
}
function beginMainRender(nextKey,{carryIfNew=false,legacyY}={}) {
  const previousY=main.dataset.positionKey?rememberRenderedPagePosition():windowScrollY();
  const saved=state.uiPositions.pages[nextKey];
  const targetY=hasOwn(state.uiPositions.pages,nextKey)?Number(saved?.y||0):legacyY!==undefined?Number(legacyY||0):carryIfNew?previousY:0;
  const token=++positionRestoreToken; restoringInterfacePosition=true; main.dataset.positionKey=nextKey;
  return {key:nextKey,targetY,token};
}
function setWindowScrollImmediately(top) {
  const root=document.documentElement; const previous=root.style.scrollBehavior;
  root.style.scrollBehavior='auto'; window.scrollTo(0,Math.max(0,Number(top||0))); root.style.scrollBehavior=previous;
}
function finishMainRender(position) {
  const apply=()=>{ if(position.token!==positionRestoreToken||main.dataset.positionKey!==position.key)return false; restoreNamedScrollers(main); setWindowScrollImmediately(position.targetY); return true; };
  apply(); requestAnimationFrame(()=>requestAnimationFrame(()=>{ if(apply())restoringInterfacePosition=false; }));
}
function rememberDialogPosition(dialog) {
  if(!dialog?.dataset.positionKey)return;
  state.uiPositions.dialogs[dialog.dataset.positionKey]={top:Math.max(0,dialog.scrollTop||0)};
  rememberNamedScrollers(dialog); scheduleInterfaceSave();
}
function restoreDialogPosition(dialog) {
  const key=dialog?.dataset.positionKey; if(!key)return;
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ const saved=state.uiPositions.dialogs[key]; dialog.scrollTop=Number(saved?.top||0); restoreNamedScrollers(dialog); }));
}
function rememberAllInterfacePositions() {
  if(!restoringInterfacePosition)rememberRenderedPagePosition();
  dialogs().forEach(rememberDialogPosition);
}
function esc(value = '') { return String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function fmtDate(value, full = false) {
  if (!value) return '未记录';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', full ? { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' } : { month:'short', day:'numeric' }).format(date);
}
function localDateTime(value = new Date()) { const d = new Date(value.getTime() - value.getTimezoneOffset()*60000); return d.toISOString().slice(0,16); }
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2300); }
function haptic(kind = 'light') { try { window.AndroidBridge?.haptic?.(kind); } catch {} }
function formatBytes(bytes) { const value=Number(bytes||0); if(!value)return ''; return value>=1048576?`${(value/1048576).toFixed(1)} MB`:`${Math.ceil(value/1024)} KB`; }

function syncUpdateAppInfo() {
  if (!window.AndroidBridge?.getAppInfo) {
    updateView={...updateView,native:false,status:'browser',message:'网页版会自动使用最新程序'};
    return;
  }
  try {
    const appInfo=JSON.parse(window.AndroidBridge.getAppInfo());
    updateView={...updateView,native:true,appInfo,status:updateView.status==='browser'?'idle':updateView.status,message:updateView.message||'自动更新已就绪'};
  } catch {
    updateView={...updateView,native:true,status:'error',message:'暂时无法读取应用版本'};
  }
}

function updateActionLabel() {
  return ({
    browser:'网页版保持最新', checking:'正在检查…', available:`下载并安装 v${updateView.available?.versionName||''}`,
    downloading:`正在下载 ${updateView.progress||0}%`, ready:'立即安装', permission:'去开启安装权限',
    installing:'等待系统安装', current:'再次检查', error:'重新检查', busy:'请稍候…', idle:'检查更新'
  })[updateView.status] || '检查更新';
}

function renderUpdatePanel() {
  const panel=$('#updatePanel'); if(!panel)return;
  const native=updateView.native;
  const auto=state.updateSettings.autoUpdate;
  const working=['checking','downloading','installing','busy'].includes(updateView.status);
  const version=native?`v${esc(updateView.appInfo?.versionName||'—')}`:'网页版';
  const size=updateView.available?.sizeBytes?` · ${formatBytes(updateView.available.sizeBytes)}`:'';
  const notes=updateView.available?.notes?`<p class="update-notes">${esc(updateView.available.notes)}</p>`:'';
  const progress=updateView.status==='downloading'?`<div class="update-progress" aria-label="下载进度 ${updateView.progress||0}%"><i style="width:${Math.max(2,Number(updateView.progress||0))}%"></i></div>`:'';
  panel.innerHTML=`<div class="update-heading"><div><span class="update-kicker">AUTO UPDATE</span><h3>软件更新 <b>${version}</b></h3></div><span class="update-state status-${esc(updateView.status)}">${updateView.status==='current'?'已是最新':native?'Android 应用':'在线版'}</span></div>
    <button class="update-toggle ${auto?'on':''}" data-action="toggle-auto-update" role="switch" aria-checked="${auto}" ${native?'':'disabled'}><span><strong>启动时自动检查更新</strong><small>${native?'GitHub 主线路不可用时，会自动切换备用线路':'网页版无需下载安装包'}</small></span><i><b></b></i></button>
    <div class="update-status"><span class="update-status-icon" aria-hidden="true">${updateView.status==='current'?'✓':updateView.status==='error'?'!':'↻'}</span><div><strong>${esc(updateView.message||'可随时手动检查新版本')}</strong>${updateView.status==='available'?`<small>MixLab ${esc(updateView.available?.versionName||'')}${size}</small>`:''}</div></div>${progress}${notes}
    <button class="primary-button full update-action" data-action="update-primary" ${working||!native?'disabled':''}>${esc(updateActionLabel())}</button>`;
}

function checkForUpdates(manual=true) {
  if(!updateView.native||!window.AndroidBridge?.checkForUpdates){showToast('网页版会自动保持最新');return;}
  updateView={...updateView,status:'checking',message:manual?'正在检查新版本':'正在自动检查更新'}; renderUpdatePanel();
  window.AndroidBridge.checkForUpdates(Boolean(manual));
}

function startUpdateDownload() {
  const available=updateView.available;
  if(!available||!window.AndroidBridge?.downloadUpdate)return;
  updateView={...updateView,status:'downloading',message:`正在下载 MixLab ${available.versionName}`,progress:0}; renderUpdatePanel();
  window.AndroidBridge.downloadUpdate(JSON.stringify({versionCode:available.versionCode,versionName:available.versionName,apkUrl:available.apkUrl,sha256:available.sha256}));
}

function runUpdatePrimaryAction() {
  if(['checking','downloading','installing','busy'].includes(updateView.status))return;
  if(updateView.status==='available'){startUpdateDownload();return;}
  if(updateView.status==='ready'){window.AndroidBridge?.installDownloadedUpdate?.();return;}
  if(updateView.status==='permission'){window.AndroidBridge?.requestInstallPermission?.();return;}
  checkForUpdates(true);
}

function handleNativeUpdateEvent(payload) {
  if(!payload||typeof payload!=='object')return;
  updateView={...updateView,native:true,status:payload.status||'idle',message:payload.message||'',progress:Number(payload.progress||0)};
  if(payload.status==='available') updateView.available=payload;
  if(['current','available','error'].includes(payload.status)) {
    state.updateSettings.lastCheckedAt=new Date().toISOString(); saveState();
  }
  renderUpdatePanel();
  if(payload.status==='ready') setTimeout(()=>window.AndroidBridge?.installDownloadedUpdate?.(),700);
}

window.MixLabUpdate={onNativeEvent:handleNativeUpdateEvent};

function scheduleAutomaticUpdateCheck() {
  if(!updateView.native||!state.updateSettings.autoUpdate)return;
  checkForUpdates(false);
}
function catalogItem(name) { return ingredientMap.get(name) || state.customIngredients.find((item) => item.name === name); }
function allIngredients() { return [...CATALOG, ...state.customIngredients.map((item)=>({ ...item, parent:item.parent || '我的材料', recipeKey:item.recipeKey || item.name }))]; }
function groupFor(name) { return catalogItem(name)?.group || '自定义材料'; }
function recipeKeyFor(name) { return catalogItem(name)?.recipeKey || name; }
function hasIngredient(name) { return state.pantry.some((ownedName)=>ownedName === name || recipeKeyFor(ownedName) === name); }
function recipeContainsIngredient(recipe, name) { const key=recipeKeyFor(name); return recipe.ingredients.some((item)=>item.name === name || item.name === key); }
function requiredIngredients(recipe) { return recipe.ingredients.filter((item) => !item.optional); }
function missingFor(recipe) { return requiredIngredients(recipe).filter((item) => !hasIngredient(item.name)); }
function recipeSessions(id) { return state.sessions.filter((item) => item.recipeId === id).sort((a,b) => new Date(b.madeAt) - new Date(a.madeAt)); }
function countFor(id) { return recipeSessions(id).length + Number(state.legacySummary[id]?.count || 0); }
function averageRating(id) {
  const ratings = recipeSessions(id).map((item) => Number(item.rating)).filter(Boolean);
  if (ratings.length) return ratings.reduce((sum, item) => sum + item, 0) / ratings.length;
  return Number(state.legacySummary[id]?.rating || 0);
}

function versionAsRecipe(version) {
  const source = BASE_RECIPES.find((item) => item.id === version.sourceRecipeId) || {};
  return {
    id:`version:${version.id}`, name:version.name, english:`我的第 ${version.versionNo} 版`, family:'我的改版', method:version.method || source.method || '摇和',
    glass:version.glass || source.glass || '鸡尾酒杯', ingredients:version.ingredients, steps:version.steps,
    profile:'经过多次实验后定稿', description:version.rationale || `基于 ${source.name || '个人实验'} 创建的改版。`, garnish:version.garnish || source.garnish || '按喜好',
    difficulty:'个人', time:source.time || 5, strength:source.strength || '自定义', custom:true, versionId:version.id, sourceRecipeId:version.sourceRecipeId
  };
}
function allRecipes() { return [...BASE_RECIPES, ...state.customRecipes, ...state.versions.map(versionAsRecipe)]; }
function findRecipe(id) { return allRecipes().find((recipe) => recipe.id === id); }
function recipeHaystack(recipe) { return [recipe.name, recipe.english, recipe.family, recipe.profile, recipe.description, ...recipe.ingredients.map((item) => item.name)].join(' ').toLowerCase(); }

function filteredRecipes() {
  const f = state.recipeFilters;
  return allRecipes().filter((recipe) => {
    if (f.query && !recipeHaystack(recipe).includes(f.query.trim().toLowerCase())) return false;
    if (f.selected.length && !f.selected.every((name) => recipeContainsIngredient(recipe,name))) return false;
    if (f.families.length && !f.families.includes(recipe.family)) return false;
    if (f.difficulty.length && !f.difficulty.includes(recipe.difficulty)) return false;
    if (f.strength.length && !f.strength.includes(recipe.strength)) return false;
    if (f.favoritesOnly && !state.favorites.includes(recipe.id)) return false;
    const missing = missingFor(recipe).length;
    if (f.mode === 'ready' && missing) return false;
    if (f.mode === 'one-away' && missing > 1) return false;
    if (f.mode === 'mine' && !recipe.custom) return false;
    return true;
  }).sort((a,b) => missingFor(a).length - missingFor(b).length || countFor(b.id) - countFor(a.id) || a.name.localeCompare(b.name,'zh-CN'));
}

function artCode(recipe) {
  const map = {'金酒':'GIN','朗姆':'RUM','龙舌兰':'TEQ','梅斯卡尔':'MEZ','伏特加':'VOD','威士忌':'WHK','白兰地':'BRY','皮斯科':'PSC','葡萄酒':'WINE','混合基酒':'MIX','利口酒':'LIQ','低酒精':'LOW','无酒精':'0.0','我的配方':'MINE','我的改版':'V+'};
  return map[recipe.family] || map[requiredIngredients(recipe)[0]?.name] || 'MIX';
}
function familyClass(recipe) { return String(recipe.family || 'mix').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g,'').slice(0,8); }

function recipeCard(recipe, compact = false) {
  const missing = missingFor(recipe);
  const rating = averageRating(recipe.id);
  const owned = missing.length === 0;
  return `<article class="recipe-card ${compact?'compact':''}" tabindex="0" role="button" data-action="open-recipe" data-id="${esc(recipe.id)}" aria-label="查看${esc(recipe.name)}">
    <div class="recipe-art family-${esc(familyClass(recipe))}" aria-hidden="true"><span>${esc(artCode(recipe))}</span><i></i></div>
    <div class="recipe-body">
      <div class="card-kicker"><span>${esc(recipe.family)}</span>${recipe.custom?'<b>我的</b>':''}</div>
      <h3>${esc(recipe.name)}</h3><p class="english">${esc(recipe.english || '')}</p>
      <p class="ingredient-preview">${recipe.ingredients.slice(0,4).map((item) => esc(item.name)).join(' · ')}</p>
      <div class="recipe-meta"><span>${recipe.time || 5} 分钟</span><span>${esc(recipe.method)}</span><span>${esc(recipe.strength)}</span></div>
      <div class="card-status ${owned?'ready':'missing'}"><span>${owned?'✓':'＋'}</span>${owned?'材料齐全':`缺 ${missing.length} 种`}${countFor(recipe.id)?` · 已调 ${countFor(recipe.id)} 次`:''}${rating?` · ${rating.toFixed(1)}★`:''}</div>
    </div>
  </article>`;
}

function emptyState(title, text, action = '') { return `<div class="empty-state"><span>◇</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`; }
function sectionTitle(title, detail = '', action = '') { return `<div class="section-heading"><div><h2>${esc(title)}</h2>${detail?`<p>${esc(detail)}</p>`:''}</div>${action}</div>`; }

function renderDiscover() {
  const position=beginMainRender('view:discover');
  const ready = allRecipes().filter((recipe) => !missingFor(recipe).length);
  const recent = [...state.sessions].sort((a,b) => new Date(b.madeAt)-new Date(a.madeAt))[0];
  const recentRecipe = recent ? findRecipe(recent.recipeId) : null;
  const suggestions = [...ready].sort((a,b) => countFor(a.id)-countFor(b.id) || a.time-b.time).slice(0,4);
  const totalExperiments = state.sessions.length + Object.values(state.legacySummary).reduce((sum,item)=>sum+Number(item.count||0),0);
  main.innerHTML = `<section class="home-dashboard">
    <img src="./assets/cocktail-still-life.png" alt="深色吧台上的三杯柑橘鸡尾酒" />
    <div class="home-dashboard-shade"></div><div class="home-dashboard-content"><p class="eyebrow accent">YOUR BAR TONIGHT</p><h1>今晚能调 <strong>${ready.length}</strong> 款</h1><p>${state.pantry.length} 种材料已在酒柜，挑一杯马上开始。</p>
      <button class="home-search" data-action="open-search" aria-label="搜索配方或材料"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6"></circle><path d="m16 16 4 4"></path></svg><span>搜索配方、材料或风味</span><b>›</b></button>
      <div class="home-primary-actions"><button class="primary-button" data-view="recipes" data-set-mode="ready">看能调的</button><button class="glass-button" data-action="open-quick-pantry">快速盘点</button></div>
    </div>
  </section>
  <section class="compact-metrics"><button data-view="recipes"><strong>${allRecipes().length}</strong><span>全部配方</span></button><button data-view="pantry"><strong>${state.pantry.length}</strong><span>柜中材料</span></button><button data-view="journal"><strong>${totalExperiments}</strong><span>调制记录</span></button></section>
  ${recent&&recentRecipe?`<section class="continue-card"><div><p class="eyebrow accent">CONTINUE</p><h2>复刻上次的 ${esc(recent.recipeName)}</h2><p>${esc(recent.ingredients.map((item)=>`${item.name} ${item.amount}`).join(' · '))}</p>${recent.nextAdjustment?`<small>上次想改：${esc(recent.nextAdjustment)}</small>`:''}</div><button class="primary-button" data-action="repeat-session" data-id="${esc(recent.id)}">按上次比例记录</button></section>`:''}
  <section class="content-section home-suggestions">${sectionTitle('今晚推荐', ready.length?`从酒柜现有材料直接开始`:'先快速盘点手边材料','<button class="text-button" data-view="recipes" data-set-mode="ready">查看全部 →</button>')}<div class="recipe-grid">${suggestions.length?suggestions.map((r)=>recipeCard(r,true)).join(''):emptyState('还没有完整匹配','快速勾选手边材料，配方结果会立即更新。','<button class="primary-button" data-action="open-quick-pantry">快速盘点</button>')}</div></section>`;
  finishMainRender(position);
}

function activeFilterCount() {
  const f = state.recipeFilters;
  return f.selected.length + f.families.length + f.difficulty.length + f.strength.length + (f.favoritesOnly?1:0);
}
function selectedFilterChips() {
  const f = state.recipeFilters;
  const chips = [
    ...f.selected.map((value)=>({type:'selected',value})), ...f.families.map((value)=>({type:'families',value})),
    ...f.difficulty.map((value)=>({type:'difficulty',value})), ...f.strength.map((value)=>({type:'strength',value}))
  ];
  if (f.favoritesOnly) chips.push({type:'favoritesOnly',value:'仅收藏'});
  return chips.length ? `<div class="active-filter-strip" data-scroll-key="recipes-active-filters">${chips.map((chip)=>`<button data-action="remove-filter" data-filter-type="${chip.type}" data-value="${esc(chip.value)}">${esc(chip.value)} ×</button>`).join('')}<button class="clear" data-action="clear-filters">清空</button></div>` : '';
}
function renderRecipes() {
  const position=beginMainRender('view:recipes');
  const results = filteredRecipes();
  const f = state.recipeFilters;
  main.innerHTML = `<section class="page-head compact-head"><p class="eyebrow accent">${allRecipes().length} RECIPES</p><h1>找配方</h1><p>按名称搜索，或组合选择多种材料。</p></section>
  <section class="recipe-toolbar"><label class="search-field inline"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6"></circle><path d="m16 16 4 4"></path></svg><input id="recipeSearchInput" value="${esc(f.query)}" type="search" placeholder="搜索名称、材料或风味" /></label><button class="filter-button ${activeFilterCount()?'active':''}" data-action="open-filter" aria-label="打开组合筛选${activeFilterCount()?`，已选 ${activeFilterCount()} 项`:''}"><span>组合筛选</span>${activeFilterCount()?`<b>${activeFilterCount()}</b>`:'<i>＋</i>'}</button></section>
  <div class="mode-tabs" role="tablist" data-scroll-key="recipes-modes">${[['all','全部'],['ready','材料齐全'],['one-away','最多缺一种'],['mine','我的改版']].map(([key,label])=>`<button role="tab" aria-selected="${f.mode===key}" class="${f.mode===key?'active':''}" data-action="set-recipe-mode" data-value="${key}">${label}</button>`).join('')}</div>
  ${selectedFilterChips()}
  <section class="result-head"><strong>${results.length} 款结果</strong><span>${f.selected.length?`必须包含：${f.selected.join('、')}`:'按材料完整度与实验次数排序'}</span></section>
  <section class="recipe-grid recipe-library">${results.length?results.map((recipe)=>recipeCard(recipe)).join(''):emptyState('没有找到完全匹配','减少一个筛选条件，或把缺少的材料加入酒柜。','<button class="secondary-button" data-action="clear-filters">清空筛选</button>')}</section>`;
  finishMainRender(position);
  $('#recipeSearchInput')?.addEventListener('input', (event) => { state.recipeFilters.query = event.target.value; saveState(); renderRecipes(); requestAnimationFrame(()=>{ const input=$('#recipeSearchInput'); input?.focus(); input?.setSelectionRange(input.value.length,input.value.length); }); });
}

const PHOTO_FALLBACKS = {
  '基酒':'Gin','利口酒':'Cointreau','葡萄酒与发酵酒':'Champagne','果汁与鲜果':'Apple%20juice','气泡与调和':'Carbonated%20water','糖浆与甜味':'Grenadine','苦精香料与装饰':'Bitters','厨房与质地':'Egg','自定义材料':'Gin'
};
function photoFallback(item) { return `https://www.thecocktaildb.com/images/ingredients/${PHOTO_FALLBACKS[item?.group] || 'Gin'}-Medium.png`; }
function ingredientPhoto(item, detail = false) {
  const src=item?.imageUrl || photoFallback(item);
  return `<img class="ingredient-photo${detail?' detail-photo':''}" src="${esc(src)}" data-fallback="${esc(photoFallback(item))}" alt="${esc(item?.name || '材料')}实物图" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
}
function wirePhotoFallbacks(root = document) {
  $$('.ingredient-photo',root).forEach((img)=>img.addEventListener('error',()=>{ const fallback=img.dataset.fallback; if(fallback&&img.src!==fallback){img.src=fallback;}else{img.classList.add('photo-unavailable');} },{once:true}));
}
function pantryParents(group) { return [...new Set(allIngredients().filter((item)=>group==='全部'||item.group===group).map((item)=>item.parent || item.name))]; }
function pantryPositionKey(group = state.pantryGroup, parent = state.pantryParent) { return `${group}::${parent || '全部'}::${state.pantryQuery?'搜索':'浏览'}`; }
function rememberPantryPosition() {
  if(state.view!=='pantry')return;
  const y=rememberRenderedPagePosition();
  state.pantryPositions[pantryPositionKey()]={y};
  const groups=$('.category-scroll'); if(groups)state.pantryNavScroll.groups=groups.scrollLeft;
  const parents=$('.subcategory-scroll'); if(parents)state.pantryNavScroll.parents[state.pantryGroup]=parents.scrollLeft;
}
function wirePantryPositionTracking() {
  $('.category-scroll')?.addEventListener('scroll',rememberPantryPosition,{passive:true});
  $('.subcategory-scroll')?.addEventListener('scroll',rememberPantryPosition,{passive:true});
}
function pantryCard(item) {
  const owned = state.pantry.includes(item.name);
  return `<article class="pantry-card ${owned?'owned':''}">
    <button class="ingredient-visual real-photo" data-action="open-ingredient" data-name="${esc(item.name)}" aria-label="查看${esc(item.name)}资料">${ingredientPhoto(item)}<span>${esc(item.parent || item.group)}</span>${item.branded?'<b>品牌实物</b>':''}</button>
    <div class="pantry-card-body"><button class="ingredient-title" data-action="open-ingredient" data-name="${esc(item.name)}"><strong>${esc(item.name)}</strong><small>${esc(item.origin)} · ${esc(item.abv)}</small></button><p>${esc(item.profile)}</p><button class="pantry-toggle ${owned?'selected':''}" data-action="toggle-pantry" data-name="${esc(item.name)}" aria-pressed="${owned}"><span>${owned?'✓':'＋'}</span>${owned?'已在酒柜':'加入酒柜'}</button></div>
  </article>`;
}
function renderPantry() {
  const wasPantry=String(main.dataset.positionKey||'').startsWith('view:pantry:');
  const catalog = allIngredients();
  const groups = ['全部', ...new Set([...INGREDIENT_GROUPS, ...state.customIngredients.map((item)=>item.group)])];
  if(!groups.includes(state.pantryGroup))state.pantryGroup='全部';
  const parents=pantryParents(state.pantryGroup);
  if(state.pantryParent!=='全部'&&!parents.includes(state.pantryParent))state.pantryParent='全部';
  const query = state.pantryQuery.trim().toLowerCase();
  const items = catalog.filter((item) => (state.pantryGroup === '全部' || item.group === state.pantryGroup) && (state.pantryParent==='全部'||item.parent===state.pantryParent) && (!query || [item.name,item.aliases,item.profile,item.use,item.parent].join(' ').toLowerCase().includes(query)));
  const readyCount = allRecipes().filter((recipe)=>!missingFor(recipe).length).length;
  const pantryKey=pantryPositionKey();
  const position=beginMainRender(`view:pantry:${pantryKey}`,{carryIfNew:wasPantry,legacyY:hasOwn(state.pantryPositions,pantryKey)?state.pantryPositions[pantryKey]?.y:undefined});
  main.innerHTML = `<section class="page-head compact-head cellar-head"><div><p class="eyebrow accent">${catalog.length} INGREDIENTS</p><h1>我的酒柜</h1><p>先选大类和类型，再勾选你实际拥有的品牌或品种。</p></div><div class="cellar-score"><strong>${readyCount}</strong><span>款可调</span></div></section>
  <section class="pantry-tools"><label class="search-field inline"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6"></circle><path d="m16 16 4 4"></path></svg><input id="pantrySearchInput" value="${esc(state.pantryQuery)}" type="search" placeholder="搜索类型、品牌或风味" /></label><button class="secondary-button" data-action="add-custom-ingredient">＋ 自定义</button></section>
  <div class="pantry-directory"><div class="directory-label"><span>大类</span><b>${esc(state.pantryGroup)}</b></div><div class="category-scroll" data-scroll-key="pantry-groups">${groups.map((group)=>`<button class="${state.pantryGroup===group?'active':''}" data-action="set-pantry-group" data-value="${esc(group)}">${esc(group)}${group==='全部'?` ${catalog.length}`:''}</button>`).join('')}</div>
  ${state.pantryGroup!=='全部'?`<div class="directory-label"><span>一级类型</span><b>${esc(state.pantryParent==='全部'?'全部类型':state.pantryParent)}</b></div><div class="subcategory-scroll" data-scroll-key="pantry-parents:${esc(state.pantryGroup)}">${['全部',...parents].map((parent)=>{const count=catalog.filter((item)=>item.group===state.pantryGroup&&(parent==='全部'||item.parent===parent)).length;return `<button class="${state.pantryParent===parent?'active':''}" data-action="set-pantry-parent" data-value="${esc(parent)}">${esc(parent)} <small>${count}</small></button>`;}).join('')}</div>`:''}</div>
  <div class="owned-summary"><span><b>${state.pantry.length}</b> 种已拥有</span><button data-action="show-owned">只看已拥有</button></div>
  <section class="pantry-result-title"><div><span>${state.pantryGroup==='全部'?'全部材料':esc(state.pantryParent==='全部'?state.pantryGroup:state.pantryParent)}</span><strong>${items.length} 项</strong></div><small>${state.pantryGroup==='基酒'||state.pantryGroup==='利口酒'?'二级为具体品牌或风格；品牌酒可直接匹配通用配方':'每个选项都可单独加入酒柜'}</small></section>
  <section class="pantry-grid">${items.length?items.map(pantryCard).join(''):emptyState('没有匹配材料','试试更短的关键词，或切换到其他品类。')}</section>`;
  wirePhotoFallbacks(main); wirePantryPositionTracking(); finishMainRender(position);
  $('#pantrySearchInput')?.addEventListener('input', (event) => { rememberPantryPosition(); state.pantryQuery = event.target.value; saveState(); renderPantry(); requestAnimationFrame(()=>{ const input=$('#pantrySearchInput'); input?.focus(); input?.setSelectionRange(input.value.length,input.value.length); }); });
}

function tasteSummary(session) {
  if (!session?.taste) return '';
  return TASTE_AXES.map(([key,label])=>`${label} ${session.taste[key] || 3}`).join(' · ');
}
function sessionCard(session, showRecipe = true) {
  return `<article class="session-card" data-action="edit-session" data-id="${esc(session.id)}" tabindex="0" role="button">
    <div class="session-date"><strong>${new Date(session.madeAt).getDate()}</strong><span>${new Date(session.madeAt).getMonth()+1}月</span></div>
    <div><div class="session-topline">${showRecipe?`<span>${esc(session.recipeName)}</span>`:''}<b>${'★'.repeat(session.rating || 0)}${'☆'.repeat(5-(session.rating||0))}</b></div><h3>${esc(session.batchName || `第 ${session.sequence || 1} 次实验`)}</h3><p>${esc(session.review || '未填写评价')}</p><small>${esc(tasteSummary(session))}</small></div><span class="chevron">›</span>
  </article>`;
}
function renderJournal() {
  const position=beginMainRender('view:journal');
  const sessions = [...state.sessions].sort((a,b)=>new Date(b.madeAt)-new Date(a.madeAt));
  const uniqueRecipes = new Set(sessions.map((item)=>item.recipeId)).size;
  const avg = sessions.length ? sessions.reduce((sum,item)=>sum+Number(item.rating||0),0)/sessions.filter((item)=>item.rating).length : 0;
  const nextIdeas = sessions.filter((item)=>item.nextAdjustment).slice(0,3);
  main.innerHTML = `<section class="page-head compact-head"><p class="eyebrow accent">TASTING JOURNAL</p><h1>实验簿</h1><p>保留每一次比例，比较后再定稿为个人改版。</p></section>
  <section class="journal-stats"><div><span>详细实验</span><strong>${sessions.length}</strong></div><div><span>涉及配方</span><strong>${uniqueRecipes}</strong></div><div><span>平均评分</span><strong>${Number.isFinite(avg)&&avg?avg.toFixed(1):'—'}</strong></div><div><span>我的改版</span><strong>${state.versions.length}</strong></div></section>
  ${nextIdeas.length?`<section class="next-panel">${sectionTitle('下次要试','最近记录的调整方向')}<div>${nextIdeas.map((item)=>`<button data-action="open-recipe" data-id="${esc(item.recipeId)}"><strong>${esc(item.recipeName)}</strong><span>${esc(item.nextAdjustment)}</span><b>›</b></button>`).join('')}</div></section>`:''}
  <section class="content-section">${sectionTitle('我的改版', state.versions.length?'已定稿的个人比例':'至少完成两次同配方实验后创建')}<div class="version-grid">${state.versions.length?state.versions.map((version)=>recipeCard(versionAsRecipe(version),true)).join(''):emptyState('还没有改版','打开任一配方，记录至少两次调制；比较差异后即可创建个人版本。')}</div></section>
  <section class="content-section">${sectionTitle('全部实验', sessions.length?`${sessions.length} 条可编辑记录`:'从任一配方的“记录本次调制”开始')}<div class="session-list">${sessions.length?sessions.map((item)=>sessionCard(item)).join(''):emptyState('实验簿还是空的','先选择一款配方，按实际用量保存第一杯。','<button class="primary-button" data-view="recipes">选择配方</button>')}</div></section>`;
  finishMainRender(position);
}

function render() {
  const renders = { discover:renderDiscover, recipes:renderRecipes, pantry:renderPantry, journal:renderJournal };
  (renders[state.view] || renderDiscover)();
  $$('.nav-item[data-view]').forEach((button)=>{ const active=button.dataset.view===state.view; button.classList.toggle('active',active); button.setAttribute('aria-current',active?'page':'false'); });
  $('#topTitle').textContent = state.view === 'discover' ? '' : ({recipes:'配方库',pantry:'我的酒柜',journal:'实验簿'}[state.view] || '');
  $('#topBackButton').hidden = state.view === 'discover';
}

function closeDialogsImmediately() { dialogs().forEach((dialog)=>{rememberDialogPosition(dialog);dialog.close();}); }
function historyIndex() { return Number(history.state?.index || 0); }
function pushLayer(layer, data = {}) { history.pushState({ mixlab:true, view:state.view, index:historyIndex()+1, layer, ...data }, '', `#${layer}`); }
function replaceLayer(layer, data = {}) { history.replaceState({ mixlab:true, view:state.view, index:historyIndex(), layer, ...data }, '', `#${layer}`); }
function showDialog(id,positionKey=id) { const dialog=$(`#${id}`); if(!dialog)return; dialog.dataset.positionKey=`dialog:${positionKey}`; if(!dialog.open)dialog.showModal(); restoreDialogPosition(dialog); }
function closeCurrentLayer(id) {
  const current = history.state;
  if (current?.layer) history.back();
  else $(`#${id}`)?.close();
}

function goBackOrHome() {
  if (history.state?.layer || historyIndex() > 0) history.back();
  else navigate('discover', false);
}

function navigate(view, push = true) {
  if (!['discover','recipes','pantry','journal'].includes(view)) return;
  rememberAllInterfacePositions();
  state.view = view; saveState(); closeDialogsImmediately(); render();
  if (push) history.pushState({mixlab:true,view,index:historyIndex()+1},'',`#view=${view}`);
  else history.replaceState({mixlab:true,view,index:historyIndex()},'',`#view=${view}`);
}

function openRecipe(id, push = true) {
  const recipe = findRecipe(id); if (!recipe) return;
  closeDialogsImmediately();
  const sessions = recipeSessions(id);
  const missing = missingFor(recipe);
  const isFavorite = state.favorites.includes(id);
  const legacy = state.legacySummary[id];
  const canVersion = sessions.length >= 2 && !recipe.versionId;
  $('#recipeDialogContent').innerHTML = `<div class="recipe-detail-head family-${esc(familyClass(recipe))}">
    <button class="dialog-back" data-close-dialog="recipeDialog" aria-label="返回">‹</button><button class="favorite-button ${isFavorite?'active':''}" data-action="toggle-favorite" data-id="${esc(id)}" aria-label="${isFavorite?'取消收藏':'收藏'}">${isFavorite?'♥':'♡'}</button>
    <div><p id="recipeDialogTitle">${esc(recipe.family)} · ${esc(recipe.method)} · ${recipe.time} 分钟</p><h2>${esc(recipe.name)}</h2><span>${esc(recipe.english || '')}</span></div><b class="detail-code">${esc(artCode(recipe))}</b>
  </div><div class="recipe-detail-body">
    <div class="availability-box ${missing.length?'warn':''}"><strong>${missing.length?`还缺 ${missing.length} 种材料`:'酒柜材料齐全，可以开始'}</strong><span>${missing.length?missing.map((item)=>esc(item.name)).join('、'):`${recipe.ingredients.length} 种材料均已勾选`}</span>${missing.length?`<button data-action="add-missing" data-id="${esc(id)}">全部加入酒柜</button>`:''}</div>
    <div class="detail-facts"><div><span>风味</span><strong>${esc(recipe.profile)}</strong></div><div><span>难度</span><strong>${esc(recipe.difficulty)}</strong></div><div><span>酒感</span><strong>${esc(recipe.strength)}</strong></div><div><span>杯型</span><strong>${esc(recipe.glass)}</strong></div></div>
    <p class="recipe-description">${esc(recipe.description)}</p>
    <section><div class="detail-section-title"><h3>标准比例</h3><span>${recipe.ingredients.length} 种材料</span></div><ul class="measure-list">${recipe.ingredients.map((item)=>`<li class="${hasIngredient(item.name)?'owned':''}"><button data-action="toggle-pantry" data-name="${esc(item.name)}">${hasIngredient(item.name)?'✓':'＋'}</button><button class="ingredient-link" data-action="open-ingredient" data-name="${esc(item.name)}">${esc(item.name)}${item.optional?' <small>可选</small>':''}</button><strong>${esc(item.amount)}</strong></li>`).join('')}</ul></section>
    <section><div class="detail-section-title"><h3>制作步骤</h3><span>${esc(recipe.method)}</span></div><ol class="step-list">${recipe.steps.map((step)=>`<li>${esc(step)}</li>`).join('')}</ol></section>
    <aside class="recipe-note"><span>比例建议</span><p>${esc(recipe.notes || '先按标准比例制作，再一次只改变一个变量。')}</p><small>装饰：${esc(recipe.garnish || '按喜好')}</small></aside>
    <section class="experiment-panel"><div class="experiment-head"><div><p class="eyebrow accent">MY EXPERIMENTS</p><h3>${sessions.length ? `${sessions.length} 次详细实验` : '还没有详细实验'}</h3></div><div class="average-score">${averageRating(id)?`${averageRating(id).toFixed(1)}<small>★</small>`:'—'}</div></div>
      ${legacy?.count?`<div class="legacy-note">旧版累计 ${legacy.count} 次${legacy.rating?` · 评分 ${legacy.rating}★`:''}${legacy.review?` · ${esc(legacy.review)}`:''}</div>`:''}
      <div class="session-list compact-list">${sessions.slice(0,4).map((item)=>sessionCard(item,false)).join('') || '<p class="muted-copy">保存每一次实际比例和评价，系统不会覆盖上一杯。</p>'}</div>
    </section>
    ${recipe.versionId?`<button class="danger-ghost full" data-action="delete-version" data-id="${esc(recipe.versionId)}">删除这个改版</button>`:''}
  </div><div class="recipe-quickbar"><button class="primary-button" data-action="new-session" data-id="${esc(id)}">记录这一杯</button><button class="secondary-button" data-action="new-version" data-id="${esc(id)}" ${canVersion?'':'disabled'}>${canVersion?'创建改版':`再调 ${Math.max(0,2-sessions.length)} 次可改版`}</button></div>`;
  showDialog('recipeDialog',`recipe:${id}`);
  if (push) pushLayer('recipe',{id});
}

function openIngredient(name, push = true) {
  const item = catalogItem(name); if (!item) { showToast('这是自定义材料，暂无资料卡'); return; }
  closeDialogsImmediately();
  const related = allRecipes().filter((recipe)=>recipeContainsIngredient(recipe,name));
  const owned = state.pantry.includes(name);
  $('#ingredientDialogContent').innerHTML = `<div class="ingredient-detail-visual real-photo">${ingredientPhoto(item,true)}<button class="dialog-back" data-close-dialog="ingredientDialog" aria-label="返回">‹</button><span>${esc(item.parent || item.group)}</span></div><div class="ingredient-detail-body"><p class="eyebrow accent">INGREDIENT GUIDE</p><h2 id="ingredientDialogTitle">${esc(item.name)}</h2><p class="aliases">${esc(item.aliases || item.group)}</p><button class="pantry-toggle large ${owned?'selected':''}" data-action="toggle-pantry" data-name="${esc(name)}" aria-pressed="${owned}"><span>${owned?'✓':'＋'}</span>${owned?'已在我的酒柜':'加入我的酒柜'}</button><div class="ingredient-facts"><div><span>大类</span><strong>${esc(item.group)}</strong></div><div><span>一级类型</span><strong>${esc(item.parent || item.group)}</strong></div><div><span>常见酒精度</span><strong>${esc(item.abv)}</strong></div><div><span>来源/风格</span><strong>${esc(item.origin)}</strong></div></div>${item.recipeKey&&item.recipeKey!==item.name?`<p class="recipe-equivalence">配方匹配：可作为“${esc(item.recipeKey)}”使用</p>`:''}<p class="photo-source">实物图片来源：<a href="${esc(item.imageSourceUrl || 'https://www.thecocktaildb.com/')}" rel="noopener noreferrer">${esc(item.imageSource || '公开实物图库')}</a></p><section><h3>风味画像</h3><p>${esc(item.profile)}</p></section><section><h3>适合怎么用</h3><p>${esc(item.use)}</p></section><section><h3>选择与使用建议</h3><p>${esc(item.tip)}</p></section><section>${sectionTitle(`含有它的配方`,`${related.length} 款`)}<div class="mini-recipe-list">${related.slice(0,8).map((recipe)=>`<button data-action="open-recipe" data-id="${esc(recipe.id)}"><span><strong>${esc(recipe.name)}</strong><small>${esc(recipe.english)}</small></span><b>›</b></button>`).join('') || '<p class="muted-copy">暂时没有内置配方使用它。</p>'}</div></section></div>`;
  wirePhotoFallbacks($('#ingredientDialogContent'));
  showDialog('ingredientDialog',`ingredient:${name}`);
  if (push) pushLayer('ingredient',{name});
}

function filterOption(type, value, label = value) {
  const selected = type === 'favoritesOnly' ? state.recipeFilters.favoritesOnly : state.recipeFilters[type].includes(value);
  return `<button class="check-chip ${selected?'selected':''}" data-action="toggle-filter-option" data-filter-type="${type}" data-value="${esc(value)}"><span>${selected?'✓':'＋'}</span>${esc(label)}</button>`;
}
function renderFilterDialog(query = '') {
  const dialog=$('#filterDialog'); if(dialog.open)rememberDialogPosition(dialog);
  const used = new Set(allRecipes().flatMap((recipe)=>recipe.ingredients.map((item)=>item.name)));
  const q = query.trim().toLowerCase();
  const families = [...new Set(allRecipes().map((recipe)=>recipe.family))];
  const groups = [...new Set([...INGREDIENT_GROUPS, ...state.customIngredients.map((item)=>item.group)])];
  $('#filterDialogContent').innerHTML = `<div class="filter-content"><label class="search-field inline"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.6"></circle><path d="m16 16 4 4"></path></svg><input id="filterIngredientSearch" value="${esc(query)}" type="search" placeholder="在筛选项中搜索材料" /></label>
    <section><h3>配方类型</h3><div class="check-cloud">${families.map((value)=>filterOption('families',value)).join('')}</div></section>
    ${groups.map((group)=>{ const items=allIngredients().filter((item)=>item.group===group&&(used.has(item.name)||used.has(item.recipeKey))&&(!q||[item.name,item.aliases,item.parent].join(' ').toLowerCase().includes(q))); return items.length?`<section><h3>${esc(group)}</h3><div class="check-cloud">${items.map((item)=>filterOption('selected',item.name)).join('')}</div></section>`:''; }).join('')}
    <section><h3>难度</h3><div class="check-cloud">${['入门','进阶','专家','个人'].map((value)=>filterOption('difficulty',value)).join('')}</div></section>
    <section><h3>酒感</h3><div class="check-cloud">${['无酒精','轻盈','中等','偏高','高','自定义'].map((value)=>filterOption('strength',value)).join('')}</div></section>
    <section><h3>收藏</h3><div class="check-cloud">${filterOption('favoritesOnly','true','仅看我收藏的配方')}</div></section>
  </div><div class="filter-footer"><button class="secondary-button" data-action="clear-filters">清空全部</button><button class="primary-button" data-close-dialog="filterDialog">查看 ${filteredRecipes().length} 款结果</button></div>`;
  if(dialog.open)restoreDialogPosition(dialog);
  $('#filterIngredientSearch')?.addEventListener('input',(event)=>{ renderFilterDialog(event.target.value); requestAnimationFrame(()=>{ const input=$('#filterIngredientSearch'); input?.focus(); input?.setSelectionRange(input.value.length,input.value.length); }); });
}
function openFilter(push = true) { closeDialogsImmediately(); renderFilterDialog(); showDialog('filterDialog'); if (push) pushLayer('filter'); }

function renderRatios(container, ingredients) {
  container.innerHTML = ingredients.map((item)=>`<div class="ratio-row"><input class="ratio-name" value="${esc(item.name)}" list="ingredientNames" aria-label="材料名称" /><input class="ratio-amount" value="${esc(item.amount)}" aria-label="用量" /><button type="button" data-action="remove-ratio-row" aria-label="删除材料">×</button></div>`).join('');
  $('#ingredientNames')?.remove();
  document.body.insertAdjacentHTML('beforeend',`<datalist id="ingredientNames">${allIngredients().map((item)=>`<option value="${esc(item.name)}"></option>`).join('')}</datalist>`);
}
function readRatios(container) { return $$('.ratio-row',container).map((row)=>({ name:$('.ratio-name',row).value.trim(), amount:$('.ratio-amount',row).value.trim(), optional:false })).filter((item)=>item.name&&item.amount); }
function addRatioRow(container) { container.insertAdjacentHTML('beforeend','<div class="ratio-row"><input class="ratio-name" list="ingredientNames" placeholder="材料" aria-label="材料名称" /><input class="ratio-amount" placeholder="用量" aria-label="用量" /><button type="button" data-action="remove-ratio-row" aria-label="删除材料">×</button></div>'); $$('.ratio-name',container).at(-1)?.focus(); }
function renderTasteSliders(taste = {}) {
  $('#tasteSliders').innerHTML = TASTE_AXES.map(([key,label,min,max])=>`<label><span>${label}<small>${min}</small></span><input type="range" name="taste-${key}" min="1" max="5" value="${taste[key]||3}" /><output>${taste[key]||3}</output><small>${max}</small></label>`).join('');
  $$('input[type="range"]',$('#tasteSliders')).forEach((input)=>input.addEventListener('input',()=>input.nextElementSibling.value=input.value));
}
function renderRating(value = 0) {
  $('#sessionForm').dataset.rating = value;
  $('#sessionRating').innerHTML = [1,2,3,4,5].map((score)=>`<button type="button" role="radio" aria-checked="${score===value}" class="${score<=value?'active':''}" data-action="set-session-rating" data-value="${score}">★</button>`).join('');
}
function openSession(recipeId, sessionId = '', push = true, templateSessionId = '') {
  const recipe = findRecipe(recipeId); if (!recipe) return;
  const existing = state.sessions.find((item)=>item.id===sessionId);
  const template = !existing && state.sessions.find((item)=>item.id===templateSessionId);
  const basis = existing || template;
  closeDialogsImmediately();
  const form = $('#sessionForm'); form.reset();
  form.elements.sessionId.value = existing?.id || '';
  form.elements.recipeId.value = recipeId;
  form.elements.madeAt.value = localDateTime(existing?.madeAt ? new Date(existing.madeAt) : new Date());
  form.elements.batchName.value = existing?.batchName || (template ? `复刻 · ${template.batchName || `第 ${template.sequence || 1} 次`}` : '');
  form.elements.ice.value = basis?.ice || (recipe.method==='搅拌'?'大冰块':'方冰');
  form.elements.method.value = basis?.method || recipe.method || '摇和';
  form.elements.review.value = existing?.review || '';
  form.elements.nextAdjustment.value = existing?.nextAdjustment || '';
  $('#sessionDialogTitle').textContent = existing ? `编辑 · ${recipe.name}` : template ? `复刻 · ${recipe.name}` : `记录 · ${recipe.name}`;
  renderRatios($('#sessionRatioEditor'), basis?.ingredients || recipe.ingredients);
  renderTasteSliders(existing?.taste || template?.taste);
  renderRating(existing?.rating || 0);
  $('#deleteSessionButton').hidden = !existing;
  $('#lastRatioButton').hidden = !recipeSessions(recipeId).length;
  $('#sessionAdvanced').open = Boolean(existing);
  showDialog('sessionDialog',`session:${recipeId}:${sessionId||templateSessionId||'new'}`);
  if (push) pushLayer('session',{recipeId,sessionId,templateSessionId});
}

function openVersion(recipeId, versionId = '', push = true) {
  const source = findRecipe(recipeId); if (!source) return;
  const existing = state.versions.find((item)=>item.id===versionId);
  const sessions = recipeSessions(recipeId);
  if (!existing && sessions.length < 2) { showToast('同一配方至少记录两次后才能创建改版'); return; }
  closeDialogsImmediately(); const form=$('#versionForm'); form.reset();
  form.elements.versionId.value = existing?.id || '';
  form.elements.sourceRecipeId.value = recipeId;
  form.elements.name.value = existing?.name || `${source.name} · 我的第 ${state.versions.filter((item)=>item.sourceRecipeId===recipeId).length+1} 版`;
  form.elements.steps.value = (existing?.steps || source.steps).join('\n');
  form.elements.rationale.value = existing?.rationale || sessions[0]?.nextAdjustment || '';
  renderRatios($('#versionRatioEditor'), existing?.ingredients || sessions[0]?.ingredients || source.ingredients);
  const picked = new Set(existing?.basedOnSessionIds || sessions.slice(0,3).map((item)=>item.id));
  $('#versionSessionPicker').innerHTML = sessions.map((item)=>`<label><input type="checkbox" value="${esc(item.id)}" ${picked.has(item.id)?'checked':''}/><span><strong>${esc(item.batchName || fmtDate(item.madeAt))}</strong><small>${fmtDate(item.madeAt)} · ${item.rating||0}★ · ${esc(item.ingredients.map((part)=>`${part.name} ${part.amount}`).join(' / '))}</small></span></label>`).join('');
  $('#versionSessionPicker').dataset.scrollKey=`version-sessions:${recipeId}`;
  showDialog('versionDialog',`version:${recipeId}:${versionId||'new'}`); if (push) pushLayer('version',{recipeId,versionId});
}

function openCustomRecipe(push = true) { closeDialogsImmediately(); $('#recipeForm').reset(); showDialog('recipeFormDialog'); if (push) pushLayer('customRecipe'); }
function openCustomIngredient(push = true) { closeDialogsImmediately(); $('#customIngredientForm').reset(); showDialog('customIngredientDialog'); if (push) pushLayer('customIngredient'); }
function openSearch(push = true) { closeDialogsImmediately(); $('#globalSearchInput').value=''; renderSearchResults(''); showDialog('searchDialog'); setTimeout(()=>$('#globalSearchInput').focus(),50); if(push) pushLayer('search'); }
function openData(push = true) { closeDialogsImmediately(); syncUpdateAppInfo(); renderUpdatePanel(); showDialog('dataDialog'); if(push) pushLayer('data'); }

function renderQuickActions() {
  const readyCount = allRecipes().filter((recipe)=>!missingFor(recipe).length).length;
  const recent = [...state.sessions].sort((a,b)=>new Date(b.madeAt)-new Date(a.madeAt))[0];
  $('#quickActionsContent').innerHTML = `<button data-action="quick-ready"><span class="quick-action-icon">◇</span><span><strong>调一杯</strong><small>${readyCount} 款材料齐全的配方</small></span><b>›</b></button>
    ${recent?`<button data-action="quick-repeat" data-id="${esc(recent.id)}"><span class="quick-action-icon">↻</span><span><strong>复刻上次</strong><small>${esc(recent.recipeName)} · ${fmtDate(recent.madeAt)}</small></span><b>›</b></button>`:''}
    <button data-action="quick-pantry"><span class="quick-action-icon">✓</span><span><strong>快速盘点酒柜</strong><small>直接勾选手边的材料</small></span><b>›</b></button>
    <button data-action="quick-custom-recipe"><span class="quick-action-icon">＋</span><span><strong>新建自由配方</strong><small>从空白比例开始创作</small></span><b>›</b></button>
    <button data-action="quick-custom-ingredient"><span class="quick-action-icon">＋</span><span><strong>添加自定义材料</strong><small>品牌酒、自制糖浆或特殊辅料</small></span><b>›</b></button>`;
}

function openQuickActions(push = true) {
  closeDialogsImmediately(); renderQuickActions(); showDialog('quickActionsDialog');
  if (push) pushLayer('quickActions');
}

function renderQuickPantry(query = '') {
  const q = query.trim().toLowerCase();
  const items = allIngredients().filter((item)=>!q || [item.name,item.aliases,item.group,item.parent,item.profile].join(' ').toLowerCase().includes(q)).sort((a,b)=>Number(state.pantry.includes(b.name))-Number(state.pantry.includes(a.name)) || a.group.localeCompare(b.group,'zh-CN') || (a.parent||'').localeCompare(b.parent||'','zh-CN') || a.name.localeCompare(b.name,'zh-CN'));
  const readyCount = allRecipes().filter((recipe)=>!missingFor(recipe).length).length;
  $('#quickPantryStatus').innerHTML = `<span><strong>${state.pantry.length}</strong> 种已拥有</span><span>可调 <strong>${readyCount}</strong> 款</span>`;
  $('#quickPantryList').innerHTML = items.length ? items.map((item)=>{ const owned=state.pantry.includes(item.name); return `<button class="${owned?'selected':''}" data-action="quick-pantry-toggle" data-name="${esc(item.name)}" aria-pressed="${owned}"><i>${owned?'✓':'＋'}</i><span><strong>${esc(item.name)}</strong><small>${esc(item.group)} · ${esc(item.parent || item.profile)}</small></span></button>`; }).join('') : '<p class="no-results">没有找到材料</p>';
}

function openQuickPantry(push = true) {
  closeDialogsImmediately(); $('#quickPantrySearch').value=''; renderQuickPantry(); showDialog('quickPantryDialog');
  if (push) pushLayer('quickPantry');
}

function renderSearchResults(query) {
  const q=query.trim().toLowerCase();
  const recipes=(q?allRecipes().filter((item)=>recipeHaystack(item).includes(q)):allRecipes().filter((item)=>!missingFor(item).length)).slice(0,12);
  const ingredients=q?allIngredients().filter((item)=>[item.name,item.aliases,item.profile].join(' ').toLowerCase().includes(q)).slice(0,6):[];
  $('#searchResults').innerHTML = `${ingredients.length?`<p class="result-label">材料资料</p>${ingredients.map((item)=>`<button data-action="open-ingredient" data-name="${esc(item.name)}"><span><strong>${esc(item.name)}</strong><small>${esc(item.group)} · ${esc(item.profile)}</small></span><b>›</b></button>`).join('')}`:''}${recipes.length?`<p class="result-label">配方</p>${recipes.map((recipe)=>`<button data-action="open-recipe" data-id="${esc(recipe.id)}"><span><strong>${esc(recipe.name)}</strong><small>${esc(recipe.english)} · ${recipe.ingredients.map((item)=>esc(item.name)).join('、')}</small></span><b>›</b></button>`).join('')}`:'<div class="no-results">没有找到结果</div>'}`;
}

function confirmAction(title, message, onConfirm) {
  $('#confirmTitle').textContent=title; $('#confirmMessage').textContent=message; pendingConfirm=onConfirm; $('#confirmDialog').showModal();
}

function applyHistoryState(entry) {
  closeDialogsImmediately();
  if (!entry?.mixlab) { state.view='discover'; render(); return; }
  state.view = entry.view || 'discover'; saveState(); render();
  if (entry.layer==='recipe') openRecipe(entry.id,false);
  if (entry.layer==='ingredient') openIngredient(entry.name,false);
  if (entry.layer==='filter') openFilter(false);
  if (entry.layer==='session') openSession(entry.recipeId,entry.sessionId,false,entry.templateSessionId);
  if (entry.layer==='version') openVersion(entry.recipeId,entry.versionId,false);
  if (entry.layer==='customRecipe') openCustomRecipe(false);
  if (entry.layer==='customIngredient') openCustomIngredient(false);
  if (entry.layer==='search') openSearch(false);
  if (entry.layer==='data') openData(false);
  if (entry.layer==='quickActions') openQuickActions(false);
  if (entry.layer==='quickPantry') openQuickPantry(false);
}

document.addEventListener('click', (event) => {
  const target=event.target.closest('button,[data-action],[data-view],[data-close-dialog]'); if(!target) return;
  const action=target.dataset.action;
  haptic('light');
  if (target.dataset.closeDialog) { closeCurrentLayer(target.dataset.closeDialog); return; }
  if (target.dataset.view) { if(target.dataset.setMode) state.recipeFilters.mode=target.dataset.setMode; navigate(target.dataset.view); return; }
  if (action==='open-search') openSearch();
  if (action==='open-quick-actions') openQuickActions();
  if (action==='open-quick-pantry') openQuickPantry();
  if (action==='quick-ready') { state.recipeFilters.mode='ready'; saveState(); navigate('recipes',false); }
  if (action==='quick-repeat') { const session=state.sessions.find((item)=>item.id===target.dataset.id); if(session){ openSession(session.recipeId,'',false,session.id); replaceLayer('session',{recipeId:session.recipeId,sessionId:'',templateSessionId:session.id}); } }
  if (action==='quick-pantry') { openQuickPantry(false); replaceLayer('quickPantry'); }
  if (action==='quick-custom-recipe') { openCustomRecipe(false); replaceLayer('customRecipe'); }
  if (action==='quick-custom-ingredient') { openCustomIngredient(false); replaceLayer('customIngredient'); }
  if (action==='repeat-session') { const session=state.sessions.find((item)=>item.id===target.dataset.id); if(session)openSession(session.recipeId,'',true,session.id); }
  if (action==='open-recipe') openRecipe(target.dataset.id);
  if (action==='open-ingredient') openIngredient(target.dataset.name);
  if (action==='open-filter') openFilter();
  if (action==='new-custom-recipe') openCustomRecipe();
  if (action==='toggle-favorite') { const id=target.dataset.id; state.favorites=state.favorites.includes(id)?state.favorites.filter((item)=>item!==id):[...state.favorites,id]; saveState(); openRecipe(id,false); showToast(state.favorites.includes(id)?'已收藏':'已取消收藏'); }
  if (action==='toggle-pantry') { const name=target.dataset.name; if(state.view==='pantry')rememberPantryPosition(); state.pantry=state.pantry.includes(name)?state.pantry.filter((item)=>item!==name):[...state.pantry,name]; saveState(); const current=history.state; if(current?.layer==='recipe')openRecipe(current.id,false);else if(current?.layer==='ingredient')openIngredient(current.name,false);else render(); showToast(state.pantry.includes(name)?`${name}已加入酒柜`:`${name}已移出酒柜`); }
  if (action==='quick-pantry-toggle') { const name=target.dataset.name; state.pantry=state.pantry.includes(name)?state.pantry.filter((item)=>item!==name):[...state.pantry,name]; saveState(); haptic('success'); renderQuickPantry($('#quickPantrySearch').value); }
  if (action==='add-missing') { const recipe=findRecipe(target.dataset.id); state.pantry=[...new Set([...state.pantry,...missingFor(recipe).map((item)=>item.name)])]; saveState(); openRecipe(recipe.id,false); showToast('缺少的材料已加入酒柜'); }
  if (action==='set-recipe-mode') { state.recipeFilters.mode=target.dataset.value; saveState(); renderRecipes(); }
  if (action==='remove-filter') { const type=target.dataset.filterType; if(type==='favoritesOnly')state.recipeFilters.favoritesOnly=false; else state.recipeFilters[type]=state.recipeFilters[type].filter((item)=>item!==target.dataset.value); saveState(); renderRecipes(); }
  if (action==='clear-filters') { state.recipeFilters={...initialState().recipeFilters,mode:state.recipeFilters.mode}; saveState(); if($('#filterDialog').open)renderFilterDialog();else renderRecipes(); }
  if (action==='toggle-filter-option') { const type=target.dataset.filterType,value=target.dataset.value; if(type==='favoritesOnly')state.recipeFilters.favoritesOnly=!state.recipeFilters.favoritesOnly; else state.recipeFilters[type]=state.recipeFilters[type].includes(value)?state.recipeFilters[type].filter((item)=>item!==value):[...state.recipeFilters[type],value]; saveState(); renderFilterDialog($('#filterIngredientSearch')?.value||''); }
  if (action==='set-pantry-group') { rememberPantryPosition(); state.pantryGroup=target.dataset.value; state.pantryParent='全部'; saveState(); renderPantry(); }
  if (action==='set-pantry-parent') { rememberPantryPosition(); state.pantryParent=target.dataset.value; saveState(); renderPantry(); }
  if (action==='show-owned') { rememberPantryPosition(); state.pantryQuery=''; state.pantryGroup='全部'; state.pantryParent='全部'; const cards=allIngredients().filter((item)=>state.pantry.includes(item.name)); main.querySelector('.pantry-grid').innerHTML=cards.length?cards.map(pantryCard).join(''):emptyState('酒柜还是空的','在材料卡片上点击“加入酒柜”。'); main.querySelector('.pantry-result-title div').innerHTML=`<span>已拥有</span><strong>${cards.length} 项</strong>`; main.querySelector('.owned-summary button').textContent=`正在显示 ${cards.length} 种`; wirePhotoFallbacks(main); saveState(); }
  if (action==='add-custom-ingredient') openCustomIngredient();
  if (action==='new-session') openSession(target.dataset.id);
  if (action==='edit-session') { const session=state.sessions.find((item)=>item.id===target.dataset.id); if(session)openSession(session.recipeId,session.id); }
  if (action==='add-session-ingredient') addRatioRow($('#sessionRatioEditor'));
  if (action==='apply-standard-ratio') { const recipe=findRecipe($('#sessionForm').elements.recipeId.value); if(recipe){renderRatios($('#sessionRatioEditor'),recipe.ingredients);showToast('已恢复标准比例');} }
  if (action==='apply-last-ratio') { const recipeId=$('#sessionForm').elements.recipeId.value; const latest=recipeSessions(recipeId).find((item)=>item.id!==$('#sessionForm').elements.sessionId.value); if(latest){renderRatios($('#sessionRatioEditor'),latest.ingredients);$('#sessionForm').elements.ice.value=latest.ice;$('#sessionForm').elements.method.value=latest.method;showToast('已带入上次比例');} }
  if (action==='add-version-ingredient') addRatioRow($('#versionRatioEditor'));
  if (action==='remove-ratio-row') target.closest('.ratio-row')?.remove();
  if (action==='set-session-rating') renderRating(Number(target.dataset.value));
  if (action==='new-version') openVersion(target.dataset.id);
  if (action==='delete-session') { const id=$('#sessionForm').elements.sessionId.value; if(!id)return; confirmAction('删除这次实验？','本次比例、评分和评价都会被删除，操作无法撤销。',()=>{state.sessions=state.sessions.filter((item)=>item.id!==id);saveState();history.back();showToast('实验记录已删除');}); }
  if (action==='delete-version') { const versionId=target.dataset.id; confirmAction('删除这个改版？','改版本身会删除，作为依据的实验记录仍会保留。',()=>{state.versions=state.versions.filter((item)=>item.id!==versionId);state.favorites=state.favorites.filter((item)=>item!==`version:${versionId}`);saveState();history.back();showToast('改版已删除');}); }
  if (action==='toggle-auto-update') { state.updateSettings.autoUpdate=!state.updateSettings.autoUpdate; saveState(); renderUpdatePanel(); showToast(state.updateSettings.autoUpdate?'已开启自动更新':'已关闭自动更新'); if(state.updateSettings.autoUpdate)setTimeout(()=>checkForUpdates(false),350); }
  if (action==='update-primary') runUpdatePrimaryAction();
  if (action==='export-data') exportData();
  if (action==='reset-data') confirmAction('恢复初始数据？','酒柜、详细实验、评价、自建配方和所有改版都会清除。请先导出备份。',()=>{state=initialState();saveState();closeDialogsImmediately();navigate('discover',false);showToast('已恢复初始数据');});
});

document.addEventListener('keydown',(event)=>{ if((event.key==='Enter'||event.key===' ')&&event.target.matches('[role="button"][data-action]')){event.preventDefault();event.target.click();} if(event.key==='Escape'&&history.state?.layer){event.preventDefault();history.back();} });
window.addEventListener('scroll',()=>{ if(restoringInterfacePosition)return; if(state.view==='pantry')rememberPantryPosition(); else rememberRenderedPagePosition(); },{passive:true});
document.addEventListener('scroll',(event)=>{ if(restoringInterfacePosition)return; const element=event.target; if(element?.matches?.('[data-scroll-key]'))rememberNamedScroller(element); if(element?.matches?.('dialog'))rememberDialogPosition(element); scheduleInterfaceSave(); },true);
window.addEventListener('pagehide',()=>{rememberAllInterfacePositions();saveState();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){rememberAllInterfacePositions();saveState();}});
dialogs().forEach((dialog)=>dialog.addEventListener('close',()=>rememberDialogPosition(dialog)));
$('#quickSearchButton').addEventListener('click',()=>openSearch());
$('#dataButton').addEventListener('click',()=>openData());
$('#homeButton').addEventListener('click',()=>navigate('discover'));
$('#topBackButton').addEventListener('click',goBackOrHome);
$('#globalSearchInput').addEventListener('input',(event)=>renderSearchResults(event.target.value));
$('#quickPantrySearch').addEventListener('input',(event)=>renderQuickPantry(event.target.value));

$('#sessionForm').addEventListener('submit',(event)=>{
  event.preventDefault(); const form=event.currentTarget; const recipe=findRecipe(form.elements.recipeId.value); const ingredients=readRatios($('#sessionRatioEditor'));
  if(!ingredients.length){showToast('请至少填写一种材料和用量');return;}
  const existing=state.sessions.find((item)=>item.id===form.elements.sessionId.value);
  const session={ id:existing?.id||uid('session'), recipeId:recipe.id, recipeName:recipe.name, madeAt:new Date(form.elements.madeAt.value).toISOString(), batchName:form.elements.batchName.value.trim(), ingredients, ice:form.elements.ice.value, method:form.elements.method.value, rating:Number(form.dataset.rating||0), taste:Object.fromEntries(TASTE_AXES.map(([key])=>[key,Number(form.elements[`taste-${key}`].value)])), review:form.elements.review.value.trim(), nextAdjustment:form.elements.nextAdjustment.value.trim(), sequence:existing?.sequence||recipeSessions(recipe.id).length+1, updatedAt:new Date().toISOString() };
  state.sessions=existing?state.sessions.map((item)=>item.id===existing.id?session:item):[...state.sessions,session]; saveState(); haptic('success'); history.back(); showToast(existing?'实验记录已更新':'这次比例已保存，不会覆盖之前记录');
});

$('#versionForm').addEventListener('submit',(event)=>{
  event.preventDefault(); const form=event.currentTarget; const source=findRecipe(form.elements.sourceRecipeId.value); const ingredients=readRatios($('#versionRatioEditor')); if(!ingredients.length){showToast('请至少填写一种材料');return;}
  const existing=state.versions.find((item)=>item.id===form.elements.versionId.value); const priorCount=state.versions.filter((item)=>item.sourceRecipeId===source.id).length;
  const version={id:existing?.id||uid('version'),sourceRecipeId:source.id,name:form.elements.name.value.trim(),ingredients,steps:form.elements.steps.value.split('\n').map((item)=>item.trim()).filter(Boolean),rationale:form.elements.rationale.value.trim(),basedOnSessionIds:$$('input:checked',$('#versionSessionPicker')).map((input)=>input.value),versionNo:existing?.versionNo||priorCount+1,method:source.method,glass:source.glass,garnish:source.garnish,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  state.versions=existing?state.versions.map((item)=>item.id===existing.id?version:item):[...state.versions,version];saveState();history.back();showToast(existing?'改版已更新':'个人改版已创建');
});

$('#recipeForm').addEventListener('submit',(event)=>{
  event.preventDefault(); const form=event.currentTarget; const ingredients=form.elements.ingredients.value.split('\n').map((line)=>{const [name,amount]=line.split('|');return{name:name?.trim(),amount:amount?.trim()||'适量',optional:false};}).filter((item)=>item.name); const steps=form.elements.steps.value.split('\n').map((item)=>item.trim()).filter(Boolean);
  const recipe={id:uid('custom'),name:form.elements.name.value.trim(),english:'My Original',family:'我的配方',method:form.elements.method.value,glass:form.elements.glass.value.trim()||'鸡尾酒杯',ingredients,steps,profile:'个人原创比例',description:form.elements.notes.value.trim()||'个人创建的自由配方。',notes:form.elements.notes.value.trim(),garnish:'按喜好',difficulty:'个人',time:5,strength:'自定义',custom:true};
  state.customRecipes.push(recipe);saveState();history.back();showToast('已保存到我的配方');
});

$('#customIngredientForm').addEventListener('submit',(event)=>{
  event.preventDefault(); const form=event.currentTarget; const name=form.elements.name.value.trim();
  if(CATALOG.some((item)=>item.name===name)||state.customIngredients.some((item)=>item.name===name)){showToast('这个材料已经存在');return;}
  state.customIngredients.push({name,group:form.elements.group.value,profile:form.elements.profile.value.trim()||'个人添加的材料。',use:'可用于自由配方和每次实验的实际比例。',tip:'建议在实验评价中记录品牌、批次和保存状态。',origin:'自定义',abv:form.elements.abv.value.trim()||'自填',aliases:'',media:'botanical',mediaPosition:{x:2,y:1}});
  state.pantry.push(name); saveState(); history.back(); showToast(`${name}已加入酒柜`);
});

$('#confirmDialog').addEventListener('close',()=>{ if($('#confirmDialog').returnValue==='confirm'&&pendingConfirm)pendingConfirm(); pendingConfirm=null; });
$('#importFile').addEventListener('change',async(event)=>{try{const file=event.target.files[0];if(!file)return;const parsed=JSON.parse(await file.text());const incoming=parsed.data||parsed;if(incoming.version!==2)throw new Error('version');state={...initialState(),...incoming,recipeFilters:{...initialState().recipeFilters,...(incoming.recipeFilters||{})},updateSettings:{...initialState().updateSettings,...(incoming.updateSettings||{})},uiPositions:{...initialState().uiPositions,...(incoming.uiPositions||{}),pages:{...(incoming.uiPositions?.pages||{})},scrollers:{...(incoming.uiPositions?.scrollers||{})},dialogs:{...(incoming.uiPositions?.dialogs||{})}}};saveState();closeDialogsImmediately();history.replaceState({mixlab:true,view:'discover',index:0},'','#view=discover');applyHistoryState(history.state);showToast('完整备份已恢复');}catch{showToast('无法读取这个 MixLab 备份');}event.target.value='';});

function exportData(){const content=JSON.stringify({app:'MixLab',schema:2,exportedAt:new Date().toISOString(),data:state},null,2);const filename=`mixlab-backup-${new Date().toISOString().slice(0,10)}.json`;if(window.AndroidBridge?.saveBackup){window.AndroidBridge.saveBackup(content,filename);showToast('请选择备份保存位置');return;}const blob=new Blob([content],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;link.click();URL.revokeObjectURL(url);showToast('备份已导出');}

window.addEventListener('popstate',(event)=>applyHistoryState(event.state));
window.addEventListener('beforeinstallprompt',(event)=>{event.preventDefault();deferredInstallPrompt=event;});
if('scrollRestoration' in history)history.scrollRestoration='manual';
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js?v=19').catch(()=>{}));
const hashView = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('view');
if(['discover','recipes','pantry','journal'].includes(hashView)) state.view = hashView;
history.replaceState({mixlab:true,view:state.view||'discover',index:0},'',`#view=${state.view||'discover'}`);
syncUpdateAppInfo();
render();
renderUpdatePanel();
setTimeout(scheduleAutomaticUpdateCheck,1200);
