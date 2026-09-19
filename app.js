/**
 * 社團意願與時段調查系統 - 核心前端邏輯
 * 包含：名冊管理、問卷狀態處理、LocalStorage 永續化、統計圖表計算、CSV 匯出、LINE 快報生成
 */

// 排除「劉禹恩」後的 21 位名單（第二個字統一以「○」代替遮蔽，唐子忻更正為唐○惞）
const ROSTER_MEMBERS = [
  '黃○仁', '吳○德',
  '林○宏', '林○淞', '許○宸',
  '陳○安', '唐○睿',
  '羅○菘',
  '李○慈', '余○彤',
  '李○澄',
  '許○琳', '許○碩',
  '許○姍',
  '林○婷', '汪○瑜',
  '唐○惞',
  '李○芸', '高○庭',
  '游○翔',
  '張○曦'
];

// 舊名字轉新遮罩名映射表（確保舊資料與既有輸入無縫相容）
const NAME_MIGRATION_MAP = {
  '黃彥仁': '黃○仁',
  '吳禹德': '吳○德',
  '林宗宏': '林○宏',
  '林士淞': '林○淞',
  '許睿宸': '許○宸',
  '陳禹安': '陳○安',
  '唐國睿': '唐○睿',
  '羅梓菘': '羅○菘',
  '李英慈': '李○慈',
  '余品彤': '余○彤',
  '李姿澄': '李○澄',
  '許煊琳': '許○琳',
  '許欣碩': '許○碩',
  '許家姍': '許○姍',
  '林詩婷': '林○婷',
  '汪采瑜': '汪○瑜',
  '唐子忻': '唐○惞',
  '唐子惞': '唐○惞',
  '唐○忻': '唐○惞',
  '李亞芸': '李○芸',
  '高誼庭': '高○庭',
  '游瀚翔': '游○翔',
  '張如曦': '張○曦'
};

function normalizeMemberName(name) {
  if (!name) return '';
  return NAME_MIGRATION_MAP[name] || name;
}

const ALL_CLUBS = ['戲劇社', '合唱團', '樂器', '廚藝'];

const ALL_TIME_SLOTS = [
  '星期一 晚上',
  '星期二 晚上',
  '星期三 晚上',
  '星期四 晚上',
  '星期五 晚上',
  '星期六 早上',
  '星期六 晚上',
  '星期日 早上',
  '星期日 晚上'
];

const WILLINGNESS_MAP = {
  high: { text: '非常有誠意／願意參加', badgeClass: 'badge-will-high', short: '有意願' },
  medium: { text: '視時間與內容而定／考慮中', badgeClass: 'badge-will-medium', short: '考慮中' },
  low: { text: '暫無意願參加', badgeClass: 'badge-will-low', short: '暫無' }
};

const STORAGE_KEY = 'club_survey_responses_v2';
const SYNC_CONFIG_KEY = 'club_survey_sync_config_v2';

// 雲端同步設定狀態
let syncConfig = {
  roomId: 'club-survey-2026',
  gasUrl: '',
  lastSyncTime: null
};

// 應用程式狀態
let responsesState = {};
let currentRosterFilter = 'all';
let currentTableSearch = '';
let activeDetailMember = null;
let broadcastChannel = null;
let cloudSyncTimer = null;
let isSyncing = false;

let lastKnownStorageRaw = '';

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  loadSyncConfig();
  loadResponsesFromStorage();
  initCrossTabSync();
  initLocalStoragePolling();
  initNavigation();
  initForm();
  initDashboardEvents();
  initCloudSettingsEvents();
  initLineReportModalEvents();
  renderAll();

  // 初始向雲端拉取最新資料
  pullFromCloud(false);

  // 啟動定時自動同步（每 4 秒自動背景靜默拉取 Google 試算表最新回覆）
  cloudSyncTimer = setInterval(() => {
    const isDashboardActive = document.getElementById('view-dashboard')?.classList.contains('active');
    if (isDashboardActive && !isSyncing && syncConfig.gasUrl && syncConfig.gasUrl.trim()) {
      pullFromCloud(false);
    }
  }, 4000);
});

// ==================== 同步設定 (Sync Config) ====================
function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      syncConfig = { ...syncConfig, ...parsed };
    }
  } catch (e) {
    console.error('載入同步設定失敗：', e);
  }

  // 支援網址參數覆蓋（方便透過 LINE 分享專屬試算表連結）
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('room') && urlParams.get('room').trim()) {
    syncConfig.roomId = urlParams.get('room').trim();
    saveSyncConfig();
  }
  if (urlParams.has('gas') && urlParams.get('gas').trim()) {
    syncConfig.gasUrl = urlParams.get('gas').trim();
    saveSyncConfig();
  }
}

function saveSyncConfig() {
  try {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(syncConfig));
  } catch (e) {
    console.error('儲存同步設定失敗：', e);
  }
}

// ==================== 本地跨分頁即時通訊 (Cross-Tab Sync) ====================
function initCrossTabSync() {
  // 1. BroadcastChannel（現代瀏覽器秒級分頁通訊）
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel('club_survey_sync_bc');
      broadcastChannel.onmessage = (event) => {
        if (event.data && event.data.type === 'DATA_UPDATED') {
          loadResponsesFromStorage();
          renderAll();
        }
      };
    }
  } catch (e) {
    console.warn('BroadcastChannel 不受支援：', e);
  }

  // 2. Storage 事件（跨視窗/跨分頁備援監聽）
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      loadResponsesFromStorage();
      renderAll();
    } else if (e.key === SYNC_CONFIG_KEY) {
      loadSyncConfig();
      updateSyncStatusUI();
    }
  });
}

// 3. 本機 Storage 輪詢（即使在 file:// 協定或 BroadcastChannel 受限時亦 100% 秒級同步）
function initLocalStoragePolling() {
  try {
    lastKnownStorageRaw = localStorage.getItem(STORAGE_KEY) || '';
  } catch (e) {}

  setInterval(() => {
    try {
      const currentRaw = localStorage.getItem(STORAGE_KEY) || '';
      if (currentRaw && currentRaw !== lastKnownStorageRaw) {
        lastKnownStorageRaw = currentRaw;
        loadResponsesFromStorage();
        renderAll();
      }
    } catch (e) {}
  }, 1200);
}

function broadcastLocalUpdate() {
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage({ type: 'DATA_UPDATED', timestamp: Date.now() });
    } catch (e) {}
  }
}

// ==================== 資料儲存 (LocalStorage) ====================
function loadResponsesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const migrated = {};
      let hasMigration = false;

      Object.keys(parsed).forEach(k => {
        const newName = normalizeMemberName(k);
        if (newName !== k) hasMigration = true;
        migrated[newName] = {
          ...parsed[k],
          name: newName
        };
      });

      responsesState = migrated;
      if (hasMigration) {
        saveResponsesToStorage(false);
      }
    } else {
      responsesState = {};
    }
  } catch (e) {
    console.error('載入儲存資料失敗：', e);
    responsesState = {};
  }
}

function saveResponsesToStorage(shouldBroadcast = true) {
  try {
    const raw = JSON.stringify(responsesState);
    localStorage.setItem(STORAGE_KEY, raw);
    lastKnownStorageRaw = raw;
    if (shouldBroadcast) {
      broadcastLocalUpdate();
    }
  } catch (e) {
    console.error('儲存資料失敗：', e);
    showToast('⚠️ 本地儲存失敗，請檢查瀏覽器容量或隱私設定');
  }
}

// ==================== 頁籤切換 ====================
function initNavigation() {
  const tabSurveyBtn = document.getElementById('tab-survey-btn');
  const tabDashboardBtn = document.getElementById('tab-dashboard-btn');
  const viewSurvey = document.getElementById('view-survey');
  const viewDashboard = document.getElementById('view-dashboard');

  function switchTab(tabName) {
    if (tabName === 'survey') {
      tabSurveyBtn.classList.add('active');
      tabDashboardBtn.classList.remove('active');
      viewSurvey.classList.add('active');
      viewDashboard.classList.remove('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      tabDashboardBtn.classList.add('active');
      tabSurveyBtn.classList.remove('active');
      viewDashboard.classList.add('active');
      viewSurvey.classList.remove('active');
      // 切換至看板時強制重新讀取本地最新資料並從雲端同步
      loadResponsesFromStorage();
      renderDashboard();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      pullFromCloud(false);
    }
  }

  tabSurveyBtn.addEventListener('click', () => switchTab('survey'));
  tabDashboardBtn.addEventListener('click', () => switchTab('dashboard'));

  // 成功彈窗前往看板
  document.getElementById('modal-go-dashboard')?.addEventListener('click', () => {
    hideSuccessModal();
    switchTab('dashboard');
  });

  document.getElementById('modal-close')?.addEventListener('click', () => {
    hideSuccessModal();
  });
}

// ==================== 表單邏輯 ====================
function initForm() {
  const selectEl = document.getElementById('member-select');
  const form = document.getElementById('survey-form');
  const otherCheck = document.getElementById('time-other-check');
  const otherContainer = document.getElementById('other-input-container');
  const otherText = document.getElementById('time-other-text');
  const resetBtn = document.getElementById('reset-survey-btn');

  // 監聽其他時段勾選
  otherCheck.addEventListener('change', (e) => {
    if (e.target.checked) {
      otherContainer.classList.remove('hidden');
      otherText.focus();
    } else {
      otherContainer.classList.add('hidden');
    }
  });

  // 監聽人員切換，自動回填舊資料
  selectEl.addEventListener('change', (e) => {
    const selectedName = e.target.value;
    loadMemberIntoForm(selectedName);
  });

  // 監聽重設按鈕
  resetBtn.addEventListener('click', () => {
    resetForm();
    showToast('表單已重設');
  });

  // 監聽表單送出
  form.addEventListener('submit', handleFormSubmit);
}

// 動態更新人員選單
function populateMemberSelect(selectedName = '') {
  const selectEl = document.getElementById('member-select');
  const currentValue = selectedName || selectEl.value;

  selectEl.innerHTML = '<option value="" disabled selected>請點擊此處選擇您的姓名...</option>';

  ROSTER_MEMBERS.forEach(name => {
    const isFilled = !!responsesState[name];
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = isFilled ? `✅ ${name}（已填寫）` : `👤 ${name}`;
    if (name === currentValue) {
      opt.selected = true;
    }
    selectEl.appendChild(opt);
  });
}

// 載入指定成員既有資料至表單
function loadMemberIntoForm(name) {
  const alertEl = document.getElementById('already-filled-alert');
  const submitBtnText = document.getElementById('submit-btn-text');
  const existing = responsesState[name];

  if (existing) {
    alertEl.classList.remove('hidden');
    submitBtnText.textContent = `更新 ${name} 的回覆`;

    // 填入意願
    if (existing.willingness) {
      const radio = document.querySelector(`input[name="willingness"][value="${existing.willingness}"]`);
      if (radio) radio.checked = true;
    }

    // 填入社團
    const clubBoxes = document.querySelectorAll('input[name="clubs"]');
    clubBoxes.forEach(box => {
      box.checked = existing.clubs && existing.clubs.includes(box.value);
    });

    // 填入時段
    const slotBoxes = document.querySelectorAll('input[name="timeSlots"]');
    slotBoxes.forEach(box => {
      box.checked = existing.timeSlots && existing.timeSlots.includes(box.value);
    });

    // 其他時段
    const otherCheck = document.getElementById('time-other-check');
    const otherContainer = document.getElementById('other-input-container');
    const otherText = document.getElementById('time-other-text');

    if (existing.otherTime && existing.otherTime.trim()) {
      otherCheck.checked = true;
      otherContainer.classList.remove('hidden');
      otherText.value = existing.otherTime;
    } else {
      otherCheck.checked = false;
      otherContainer.classList.add('hidden');
      otherText.value = '';
    }

    // 備註
    document.getElementById('survey-notes').value = existing.notes || '';
  } else {
    alertEl.classList.add('hidden');
    submitBtnText.textContent = '確認並送出問卷';
    clearFormFieldsExceptName();
  }
}

function clearFormFieldsExceptName() {
  // 清除意願單選
  const radios = document.querySelectorAll('input[name="willingness"]');
  radios.forEach(r => r.checked = false);

  // 清除社團勾選
  const clubBoxes = document.querySelectorAll('input[name="clubs"]');
  clubBoxes.forEach(cb => cb.checked = false);

  // 清除時段勾選
  const slotBoxes = document.querySelectorAll('input[name="timeSlots"]');
  slotBoxes.forEach(sb => sb.checked = false);

  // 清除其他時段
  const otherCheck = document.getElementById('time-other-check');
  const otherContainer = document.getElementById('other-input-container');
  const otherText = document.getElementById('time-other-text');
  otherCheck.checked = false;
  otherContainer.classList.add('hidden');
  otherText.value = '';

  // 清除備註
  document.getElementById('survey-notes').value = '';
}

function resetForm() {
  document.getElementById('member-select').value = '';
  document.getElementById('already-filled-alert').classList.add('hidden');
  document.getElementById('submit-btn-text').textContent = '確認並送出問卷';
  clearFormFieldsExceptName();
}

// 處理送出
function handleFormSubmit(e) {
  e.preventDefault();

  const selectEl = document.getElementById('member-select');
  const name = selectEl.value;

  if (!name) {
    showToast('⚠️ 請先選擇您的姓名！');
    document.getElementById('card-member-select').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  const willingnessRadio = document.querySelector('input[name="willingness"]:checked');
  if (!willingnessRadio) {
    showToast('⚠️ 請選擇是否有參與意願！');
    document.getElementById('card-willingness').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const willingness = willingnessRadio.value;

  // 取得社團
  const clubs = Array.from(document.querySelectorAll('input[name="clubs"]:checked')).map(el => el.value);

  // 取得時段
  const timeSlots = Array.from(document.querySelectorAll('input[name="timeSlots"]:checked')).map(el => el.value);

  // 取得自訂其他時段
  const otherCheck = document.getElementById('time-other-check');
  const otherText = document.getElementById('time-other-text').value.trim();
  const otherTime = otherCheck.checked ? otherText : '';

  // 備註
  const notes = document.getElementById('survey-notes').value.trim();

  // 若有意願但未選社團或時段，做溫馨提醒
  if (willingness !== 'low' && clubs.length === 0 && timeSlots.length === 0 && !otherTime) {
    const confirmNoChoice = confirm('您有意願參加社團，但尚未勾選任何社團與時段，確定要直接送出嗎？');
    if (!confirmNoChoice) return;
  }

  // 儲存記錄
  const now = new Date();
  const timeStr = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  const isUpdate = !!responsesState[name];

  responsesState[name] = {
    name,
    willingness,
    willingnessText: WILLINGNESS_MAP[willingness]?.text || '',
    clubs,
    timeSlots,
    otherTime,
    notes,
    updatedAt: timeStr
  };

  saveResponsesToStorage(true);
  renderAll();

  // 即時將此筆回覆推送至雲端
  pushToCloud(responsesState[name]);

  // 顯示成功彈窗
  showSuccessModal(name, isUpdate);
}

function showSuccessModal(name, isUpdate) {
  const modal = document.getElementById('success-modal');
  const title = document.getElementById('modal-title');
  const desc = document.getElementById('modal-message');

  title.textContent = isUpdate ? `🎉 ${name} 的回覆已更新！` : `🎉 感謝 ${name}，回覆已成功送出！`;
  desc.textContent = `您的社團意願與可出席時段已即時寫入系統，統計看板已同步更新。感謝您協助大家籌備社團！`;

  modal.classList.remove('hidden');
}

function hideSuccessModal() {
  document.getElementById('success-modal').classList.add('hidden');
}

// ==================== 統計看板渲染 ====================
function renderAll() {
  const currentSelectVal = document.getElementById('member-select')?.value;
  populateMemberSelect(currentSelectVal);
  renderHeaderBadge();
  renderDashboard();
}

function renderHeaderBadge() {
  const count = Object.keys(responsesState).length;
  const badge = document.getElementById('response-count-badge');
  if (badge) {
    badge.textContent = count;
  }
}

function renderDashboard() {
  const responses = Object.values(responsesState);
  const totalRoster = ROSTER_MEMBERS.length;
  const filledCount = responses.length;
  const unfilledCount = totalRoster - filledCount;
  const fillRate = totalRoster > 0 ? Math.round((filledCount / totalRoster) * 100) : 0;

  // 1. 核心指標更新
  document.getElementById('metric-filled-count').textContent = filledCount;
  document.getElementById('metric-roster-total').textContent = totalRoster;
  document.getElementById('metric-progress-bar').style.width = `${fillRate}%`;
  document.getElementById('metric-fill-rate').textContent = `${fillRate}%`;

  let highCount = 0;
  let medCount = 0;
  let lowCount = 0;

  responses.forEach(r => {
    if (r.willingness === 'high') highCount++;
    else if (r.willingness === 'medium') medCount++;
    else if (r.willingness === 'low') lowCount++;
  });

  document.getElementById('metric-will-high').textContent = highCount;
  document.getElementById('metric-will-medium').textContent = medCount;
  document.getElementById('metric-will-low').textContent = lowCount;

  // 2. 名冊狀態追蹤盤
  renderRosterGrid();

  // 3. 社團熱門排行計算
  const clubCounts = {};
  const clubVoters = {};
  ALL_CLUBS.forEach(c => {
    clubCounts[c] = 0;
    clubVoters[c] = [];
  });

  responses.forEach(r => {
    if (Array.isArray(r.clubs)) {
      r.clubs.forEach(c => {
        if (clubCounts[c] !== undefined) {
          clubCounts[c]++;
          clubVoters[c].push(r.name);
        }
      });
    }
  });

  // 找出第一名社團
  let topClub = '-';
  let topClubVotes = 0;
  ALL_CLUBS.forEach(c => {
    if (clubCounts[c] > topClubVotes) {
      topClubVotes = clubCounts[c];
      topClub = c;
    }
  });

  const metricTopClubEl = document.getElementById('metric-top-club');
  const metricTopClubVotesEl = document.getElementById('metric-top-club-votes');
  if (topClubVotes > 0) {
    metricTopClubEl.textContent = topClub;
    metricTopClubVotesEl.textContent = `共 ${topClubVotes} 人選擇 (${Math.round((topClubVotes / (filledCount || 1)) * 100)}%)`;
  } else {
    metricTopClubEl.textContent = '-';
    metricTopClubVotesEl.textContent = '尚無投票';
  }

  renderClubStats(clubCounts, clubVoters, filledCount);

  // 4. 時段熱門度計算
  const slotCounts = {};
  const slotVoters = {};
  ALL_TIME_SLOTS.forEach(s => {
    slotCounts[s] = 0;
    slotVoters[s] = [];
  });

  responses.forEach(r => {
    if (Array.isArray(r.timeSlots)) {
      r.timeSlots.forEach(s => {
        if (slotCounts[s] !== undefined) {
          slotCounts[s]++;
          slotVoters[s].push(r.name);
        }
      });
    }
  });

  // 找出第一名時段
  let topSlot = '-';
  let topSlotVotes = 0;
  ALL_TIME_SLOTS.forEach(s => {
    if (slotCounts[s] > topSlotVotes) {
      topSlotVotes = slotCounts[s];
      topSlot = s;
    }
  });

  const metricTopSlotEl = document.getElementById('metric-top-slot');
  const metricTopSlotVotesEl = document.getElementById('metric-top-slot-votes');
  if (topSlotVotes > 0) {
    metricTopSlotEl.textContent = topSlot;
    metricTopSlotVotesEl.textContent = `共 ${topSlotVotes} 人可出席 (${Math.round((topSlotVotes / (filledCount || 1)) * 100)}%)`;
  } else {
    metricTopSlotEl.textContent = '-';
    metricTopSlotVotesEl.textContent = '尚無選擇';
  }

  renderTimeSlotStats(slotCounts, slotVoters, filledCount);

  // 5. 自訂其他時段與備註
  renderCustomNotes(responses);

  // 6. 詳細資料表格
  renderResponsesTable(responses);
}

// 渲染 21 人名冊狀態卡片
function renderRosterGrid() {
  const container = document.getElementById('roster-grid');
  const filledCountEl = document.getElementById('filter-filled-count');
  const unfilledCountEl = document.getElementById('filter-unfilled-count');

  let filled = 0;
  let unfilled = 0;

  ROSTER_MEMBERS.forEach(name => {
    if (responsesState[name]) filled++;
    else unfilled++;
  });

  filledCountEl.textContent = filled;
  unfilledCountEl.textContent = unfilled;

  container.innerHTML = '';

  ROSTER_MEMBERS.forEach(name => {
    const isFilled = !!responsesState[name];

    if (currentRosterFilter === 'filled' && !isFilled) return;
    if (currentRosterFilter === 'unfilled' && isFilled) return;

    const card = document.createElement('div');
    card.className = `roster-card ${isFilled ? 'filled' : 'unfilled'}`;
    card.title = isFilled ? `點擊查看 ${name} 的回覆` : `點擊為 ${name} 填寫問卷`;

    card.innerHTML = `
      <span class="roster-name">${name}</span>
      <span class="roster-status-indicator">${isFilled ? '✓' : '…'}</span>
    `;

    card.addEventListener('click', () => {
      if (isFilled) {
        openMemberDetailModal(name);
      } else {
        // 切換至問卷填寫頁並選中此人
        document.getElementById('tab-survey-btn').click();
        const select = document.getElementById('member-select');
        select.value = name;
        loadMemberIntoForm(name);
        showToast(`已為您切換至 ${name} 的填寫表單`);
      }
    });

    container.appendChild(card);
  });
}

// 渲染社團統計長條圖
function renderClubStats(clubCounts, clubVoters, totalFilled) {
  const container = document.getElementById('club-stats-list');
  container.innerHTML = '';

  const clubClassMap = {
    '戲劇社': { class: 'bar-drama', icon: '🎭' },
    '合唱團': { class: 'bar-choir', icon: '🎶' },
    '樂器': { class: 'bar-instrument', icon: '🎸' },
    '廚藝': { class: 'bar-cooking', icon: '🍳' }
  };

  // 依票數排序
  const sortedClubs = [...ALL_CLUBS].sort((a, b) => (clubCounts[b] || 0) - (clubCounts[a] || 0));

  sortedClubs.forEach(club => {
    const count = clubCounts[club] || 0;
    const pct = totalFilled > 0 ? Math.round((count / totalFilled) * 100) : 0;
    const voters = clubVoters[club] || [];
    const votersStr = voters.length > 0 ? voters.join('、') : '尚無人選擇';
    const meta = clubClassMap[club] || { class: 'bar-drama', icon: '✨' };

    const item = document.createElement('div');
    item.className = 'stats-bar-item';
    item.innerHTML = `
      <div class="stats-bar-meta">
        <span class="stats-item-name">${meta.icon} ${club}</span>
        <span class="stats-item-stats">${count} 票 (${pct}%)</span>
      </div>
      <div class="stats-bar-track">
        <div class="stats-bar-progress ${meta.class}" style="width: ${pct}%;"></div>
      </div>
      <div class="stats-voters-row" title="名單：${votersStr}">
        👥 名單：${votersStr}
      </div>
    `;
    container.appendChild(item);
  });
}

// 渲染時段熱門度長條圖
function renderTimeSlotStats(slotCounts, slotVoters, totalFilled) {
  const container = document.getElementById('timeslot-stats-list');
  container.innerHTML = '';

  // 依得票數由大到小排序
  const sortedSlots = [...ALL_TIME_SLOTS].sort((a, b) => (slotCounts[b] || 0) - (slotCounts[a] || 0));

  sortedSlots.forEach(slot => {
    const count = slotCounts[slot] || 0;
    const pct = totalFilled > 0 ? Math.round((count / totalFilled) * 100) : 0;
    const voters = slotVoters[slot] || [];
    const votersStr = voters.length > 0 ? voters.join('、') : '無人選擇';
    const isWeekend = slot.includes('六') || slot.includes('日');
    const barClass = isWeekend ? 'bar-slot-weekend' : 'bar-slot-weekday';
    const icon = isWeekend ? '☀️' : '🌙';

    const item = document.createElement('div');
    item.className = 'stats-bar-item';
    item.innerHTML = `
      <div class="stats-bar-meta">
        <span class="stats-item-name">${icon} ${slot}</span>
        <span class="stats-item-stats">${count} 人 (${pct}%)</span>
      </div>
      <div class="stats-bar-track">
        <div class="stats-bar-progress ${barClass}" style="width: ${pct}%;"></div>
      </div>
      <div class="stats-voters-row" title="名單：${votersStr}">
        👥 可出席：${votersStr}
      </div>
    `;
    container.appendChild(item);
  });
}

// 渲染自訂其他時段與留言備註
function renderCustomNotes(responses) {
  const container = document.getElementById('custom-notes-list');
  const countEl = document.getElementById('custom-notes-count');
  container.innerHTML = '';

  const notesList = responses.filter(r => (r.otherTime && r.otherTime.trim()) || (r.notes && r.notes.trim()));
  countEl.textContent = `${notesList.length} 則紀錄`;

  if (notesList.length === 0) {
    container.innerHTML = `<div class="empty-state">目前尚無成員填寫自訂時段或留言備註。</div>`;
    return;
  }

  notesList.forEach(r => {
    const card = document.createElement('div');
    card.className = 'note-card';

    let contentHtml = '';
    if (r.otherTime && r.otherTime.trim()) {
      contentHtml += `<div style="margin-bottom: 6px;"><strong style="color: #fbbf24;">時段自訂：</strong>${escapeHtml(r.otherTime)}</div>`;
    }
    if (r.notes && r.notes.trim()) {
      contentHtml += `<div><strong style="color: #c7d2fe;">留言：</strong>${escapeHtml(r.notes)}</div>`;
    }

    card.innerHTML = `
      <div class="note-header">
        <span class="note-author">👤 ${r.name}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">${r.updatedAt || ''}</span>
      </div>
      <div class="note-content">
        ${contentHtml}
      </div>
    `;
    container.appendChild(card);
  });
}

// 渲染表格
function renderResponsesTable(responses) {
  const tbody = document.getElementById('responses-table-body');
  tbody.innerHTML = '';

  let filtered = responses;
  if (currentTableSearch) {
    const q = currentTableSearch.toLowerCase();
    filtered = responses.filter(r => {
      const nameMatch = r.name.toLowerCase().includes(q);
      const clubsMatch = (r.clubs || []).some(c => c.toLowerCase().includes(q));
      const timesMatch = (r.timeSlots || []).some(t => t.toLowerCase().includes(q));
      const notesMatch = (r.notes || '').toLowerCase().includes(q) || (r.otherTime || '').toLowerCase().includes(q);
      return nameMatch || clubsMatch || timesMatch || notesMatch;
    });
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${responses.length === 0 ? '尚未收到任何回覆' : '查無符合搜尋條件的資料'}</td></tr>`;
    return;
  }

  filtered.forEach(r => {
    const tr = document.createElement('tr');

    const willInfo = WILLINGNESS_MAP[r.willingness] || { short: r.willingness || '未填', badgeClass: 'badge-will-low' };

    const clubsHtml = (r.clubs && r.clubs.length > 0)
      ? `<div class="table-chip-list">${r.clubs.map(c => `<span class="table-chip">${c}</span>`).join('')}</div>`
      : '<span style="color: var(--text-muted);">-</span>';

    const timeSlotsHtml = (r.timeSlots && r.timeSlots.length > 0)
      ? `<div class="table-chip-list">${r.timeSlots.map(t => `<span class="table-chip">${t}</span>`).join('')}</div>`
      : '<span style="color: var(--text-muted);">-</span>';

    const customText = [r.otherTime ? `[其他時段] ${r.otherTime}` : '', r.notes].filter(Boolean).join(' | ');

    tr.innerHTML = `
      <td><strong>${r.name}</strong></td>
      <td><span class="badge-will ${willInfo.badgeClass}">${willInfo.short}</span></td>
      <td>${clubsHtml}</td>
      <td>${timeSlotsHtml}</td>
      <td style="max-width: 220px; white-space: normal; font-size: 0.82rem; color: #cbd5e1;">${escapeHtml(customText || '-')}</td>
      <td style="font-size: 0.78rem; color: var(--text-muted); white-space: nowrap;">${r.updatedAt || '-'}</td>
      <td>
        <button type="button" class="table-action-btn" data-action="detail" data-name="${r.name}">檢視</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 綁定表格點擊
  tbody.querySelectorAll('.table-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      openMemberDetailModal(name);
    });
  });
}

// ==================== 看板按鈕與互動事件 ====================
function initDashboardEvents() {
  // 名冊篩選器切換
  const filterPills = document.querySelectorAll('.roster-filters .filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentRosterFilter = pill.getAttribute('data-roster-filter');
      renderRosterGrid();
    });
  });

  // 表格即時搜尋
  const searchInput = document.getElementById('table-search-input');
  searchInput.addEventListener('input', (e) => {
    currentTableSearch = e.target.value.trim();
    renderResponsesTable(Object.values(responsesState));
  });

  // 立即同步按鈕
  document.getElementById('btn-sync-now')?.addEventListener('click', () => {
    manualSync();
  });

  // 頂部雲端標籤點擊開啟設定
  document.getElementById('cloud-sync-status')?.addEventListener('click', () => {
    openCloudSettingsModal();
  });

  // 雲端設定按鈕
  document.getElementById('btn-cloud-config')?.addEventListener('click', () => {
    openCloudSettingsModal();
  });

  // 分享問卷網址
  document.getElementById('btn-share-link')?.addEventListener('click', () => {
    copyShareUrl();
  });

  // 匯出 CSV 按鈕
  document.getElementById('btn-export-csv').addEventListener('click', exportToCSV);

  // 複製 LINE 快報
  document.getElementById('btn-copy-report').addEventListener('click', copyLineReport);

  // 載入示範資料
  document.getElementById('btn-mock-data').addEventListener('click', loadMockData);

  // 清空所有資料
  document.getElementById('btn-clear-data').addEventListener('click', clearAllData);

  // 詳情彈窗事件
  document.getElementById('detail-modal-close').addEventListener('click', closeMemberDetailModal);
  document.getElementById('member-detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'member-detail-modal') closeMemberDetailModal();
  });

  document.getElementById('detail-edit-btn').addEventListener('click', () => {
    if (!activeDetailMember) return;
    const name = activeDetailMember;
    closeMemberDetailModal();
    document.getElementById('tab-survey-btn').click();
    document.getElementById('member-select').value = name;
    loadMemberIntoForm(name);
    showToast(`已載入 ${name} 的資料，可進行修改`);
  });

  document.getElementById('detail-delete-btn').addEventListener('click', () => {
    if (!activeDetailMember) return;
    const name = activeDetailMember;
    if (confirm(`確定要刪除 ${name} 的填寫紀錄嗎？`)) {
      delete responsesState[name];
      saveResponsesToStorage(true);
      pushToCloud();
      closeMemberDetailModal();
      renderAll();
      showToast(`已刪除 ${name} 的填寫紀錄`);
    }
  });
}

// ==================== 成員回覆彈窗 ====================
function openMemberDetailModal(name) {
  const r = responsesState[name];
  if (!r) return;

  activeDetailMember = name;
  const modal = document.getElementById('member-detail-modal');
  document.getElementById('detail-member-name').textContent = name;

  const willInfo = WILLINGNESS_MAP[r.willingness] || { text: '未填', badgeClass: 'badge-will-low' };
  const statusBadge = document.getElementById('detail-fill-status');
  statusBadge.className = `status-badge ${willInfo.badgeClass}`;
  statusBadge.textContent = willInfo.text;

  const body = document.getElementById('detail-modal-body');
  const clubsStr = (r.clubs && r.clubs.length > 0) ? r.clubs.join('、') : '無選擇';
  const timesStr = (r.timeSlots && r.timeSlots.length > 0) ? r.timeSlots.join('、') : '無選擇';

  body.innerHTML = `
    <div class="detail-item">
      <span class="detail-label">參與意願</span>
      <div class="detail-value">${willInfo.text}</div>
    </div>
    <div class="detail-item">
      <span class="detail-label">想參加的社團</span>
      <div class="detail-value" style="color: #a5b4fc; font-weight: 700;">${clubsStr}</div>
    </div>
    <div class="detail-item">
      <span class="detail-label">方便出席的時間</span>
      <div class="detail-value">${timesStr}</div>
    </div>
    ${r.otherTime ? `
      <div class="detail-item">
        <span class="detail-label">其他自訂時段</span>
        <div class="detail-value" style="color: #fcd34d;">${escapeHtml(r.otherTime)}</div>
      </div>
    ` : ''}
    ${r.notes ? `
      <div class="detail-item">
        <span class="detail-label">留言備註</span>
        <div class="detail-value">${escapeHtml(r.notes)}</div>
      </div>
    ` : ''}
    <div class="detail-item">
      <span class="detail-label">最後填寫時間</span>
      <div class="detail-value" style="font-size: 0.82rem; color: var(--text-muted);">${r.updatedAt || '-'}</div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function closeMemberDetailModal() {
  document.getElementById('member-detail-modal').classList.add('hidden');
  activeDetailMember = null;
}

// ==================== CSV 匯出功能 ====================
function exportToCSV() {
  const responses = Object.values(responsesState);
  if (responses.length === 0) {
    showToast('⚠️ 目前尚無任何填寫資料可匯出！');
    return;
  }

  // 欄位標題
  const headers = ['姓名', '參與意願', '想參加的社團', '方便出席時段', '自訂其他時段', '留言備註', '填寫時間'];
  
  const rows = responses.map(r => {
    const willText = WILLINGNESS_MAP[r.willingness]?.short || r.willingness || '';
    const clubsText = (r.clubs || []).join(';');
    const timeSlotsText = (r.timeSlots || []).join(';');
    const otherTimeText = r.otherTime || '';
    const notesText = r.notes || '';
    const updatedAt = r.updatedAt || '';

    return [
      csvEscape(r.name),
      csvEscape(willText),
      csvEscape(clubsText),
      csvEscape(timeSlotsText),
      csvEscape(otherTimeText),
      csvEscape(notesText),
      csvEscape(updatedAt)
    ].join(',');
  });

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `社團意願與時段調查統計_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('📥 已成功匯出 CSV 表格！');
}

function csvEscape(str) {
  if (str === null || str === undefined) return '""';
  const text = String(str).replace(/"/g, '""');
  return `"${text}"`;
}

// ==================== LINE 統計快報生成與複製 ====================
async function copyLineReport() {
  // 1. 先強制自本地 Storage 讀取最新資料
  loadResponsesFromStorage();

  // 2. 背景觸發向雲端嘗試拉取最新同步（若聯網）
  try {
    await pullFromCloud(false);
  } catch (e) {}

  generateAndDisplayLineReport();
}

function generateAndDisplayLineReport() {
  const responses = Object.values(responsesState);
  const total = ROSTER_MEMBERS.length;
  const filled = responses.length;

  if (filled === 0) {
    showToast('⚠️ 尚無任何回覆，快報無法生成！');
    return;
  }

  // 計算社團得票
  const clubCounts = {};
  ALL_CLUBS.forEach(c => clubCounts[c] = 0);
  responses.forEach(r => {
    (r.clubs || []).forEach(c => {
      if (clubCounts[c] !== undefined) clubCounts[c]++;
    });
  });

  // 計算時段得票
  const slotCounts = {};
  ALL_TIME_SLOTS.forEach(s => slotCounts[s] = 0);
  responses.forEach(r => {
    (r.timeSlots || []).forEach(s => {
      if (slotCounts[s] !== undefined) slotCounts[s]++;
    });
  });

  const sortedClubs = [...ALL_CLUBS].sort((a, b) => clubCounts[b] - clubCounts[a]);
  const sortedSlots = [...ALL_TIME_SLOTS].sort((a, b) => slotCounts[b] - slotCounts[a]).slice(0, 3);

  let highWill = 0, medWill = 0, lowWill = 0;
  responses.forEach(r => {
    if (r.willingness === 'high') highWill++;
    else if (r.willingness === 'medium') medWill++;
    else if (r.willingness === 'low') lowWill++;
  });

  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });
  const text = [
    `📢【社團意願與時段調查即時快報】`,
    `--------------------------`,
    `📊 填寫進度：${filled} / ${total} 人（${Math.round((filled/total)*100)}%）`,
    `✨ 意向統計：有意願 ${highWill}人｜考慮中 ${medWill}人｜暫無 ${lowWill}人`,
    ``,
    `🏆 社團熱門度排行：`,
    ...sortedClubs.map((c, i) => `  ${i+1}. ${c}：${clubCounts[c]} 票`),
    ``,
    `⏰ 最多人可出席時段 TOP 3：`,
    ...sortedSlots.map((s, i) => `  ${i+1}. ${s}：${slotCounts[s]} 人`),
    `--------------------------`,
    `（統計時間：${nowStr}）`
  ].join('\n');

  // 填入預覽彈窗
  const modal = document.getElementById('line-report-modal');
  const pre = document.getElementById('line-report-text-pre');
  if (pre) pre.textContent = text;
  if (modal) modal.classList.remove('hidden');

  // 嘗試複製至剪貼簿
  executeClipboardCopy(text, '📋 已複製 LINE 統計快報至剪貼簿！可直接貼上群組');
}

// 彈窗事件綁定
function initLineReportModalEvents() {
  const modal = document.getElementById('line-report-modal');
  const closeBtn = document.getElementById('line-report-close');
  const closeBtn2 = document.getElementById('line-report-modal-close-btn');
  const copyAgainBtn = document.getElementById('btn-copy-report-again');
  const selectAllBtn = document.getElementById('btn-select-all-report');
  const pre = document.getElementById('line-report-text-pre');

  function closeModal() {
    modal?.classList.add('hidden');
  }

  closeBtn?.addEventListener('click', closeModal);
  closeBtn2?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e) => {
    if (e.target.id === 'line-report-modal') closeModal();
  });

  copyAgainBtn?.addEventListener('click', () => {
    const text = pre?.textContent || '';
    if (text) {
      executeClipboardCopy(text, '📋 已成功複製最新快報至剪貼簿！');
    }
  });

  selectAllBtn?.addEventListener('click', () => {
    if (pre) {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      showToast('🔍 已為您全選快報文字，可直接按複製！');
    }
  });
}

// ==================== 雲端同步核心引擎 (Cloud Sync Engine) ====================
function formatCurrentTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function updateSyncStatusUI(status, message) {
  const dot = document.getElementById('sync-dot-indicator');
  const text = document.getElementById('sync-status-text');
  const badge = document.getElementById('settings-status-badge');

  if (!dot || !text) return;

  if (status === 'syncing') {
    dot.className = 'sync-dot syncing';
    text.textContent = message || '正在同步中...';
  } else if (status === 'online') {
    dot.className = 'sync-dot online';
    text.textContent = message || `已連線 (${formatCurrentTime()})`;
    if (badge) {
      badge.className = 'status-badge badge-will-high';
      badge.textContent = message || '雲端同步正常';
    }
  } else if (status === 'offline') {
    dot.className = 'sync-dot offline';
    text.textContent = message || '離線快取模式';
    if (badge) {
      badge.className = 'status-badge badge-will-medium';
      badge.textContent = message || '離線快取模式';
    }
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 6000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// ==================== 雲端同步核心引擎 (Google Sheets Sync Engine) ====================
function formatCurrentTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function updateSyncStatusUI(status = 'auto', message = '') {
  const dot = document.getElementById('sync-dot-indicator');
  const text = document.getElementById('sync-status-text');
  const banner = document.getElementById('cloud-sync-notice-banner');

  const hasGas = !!(syncConfig.gasUrl && syncConfig.gasUrl.trim());

  if (!hasGas) {
    if (dot) dot.className = 'sync-dot offline';
    if (text) text.textContent = '單機模式 (未連線試算表)';
    if (banner) {
      banner.className = 'cloud-sync-banner unconfigured';
      const icon = banner.querySelector('.banner-icon');
      const title = banner.querySelector('.banner-title');
      const desc = banner.querySelector('.banner-desc');
      const btn = banner.querySelector('button');
      if (icon) icon.textContent = '📡';
      if (title) title.textContent = '目前為「單機測試模式」：資料僅保存在此裝置';
      if (desc) desc.textContent = '若要讓 21 位成員在各自手機填寫後，主辦人能在此看板自動即時匯總，請串接 Google 試算表（完全免費、永久保存、只要 1 分鐘即可設定）。';
      if (btn) {
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = '⚡ 1 分鐘連線 Google 試算表';
      }
    }
    return;
  }

  // 已設定 Google 試算表
  if (status === 'syncing') {
    if (dot) dot.className = 'sync-dot syncing';
    if (text) text.textContent = message || '正在向試算表同步...';
  } else if (status === 'offline') {
    if (dot) dot.className = 'sync-dot offline';
    if (text) text.textContent = message || '試算表連線中斷';
    if (banner) {
      banner.className = 'cloud-sync-banner unconfigured';
      const icon = banner.querySelector('.banner-icon');
      const title = banner.querySelector('.banner-title');
      const desc = banner.querySelector('.banner-desc');
      const btn = banner.querySelector('button');
      if (icon) icon.textContent = '⚠️';
      if (title) title.textContent = 'Google 試算表連線中斷';
      if (desc) desc.textContent = '無法連線至您的 Apps Script 網址，請確認部署權限「誰可以存取」是否設為「所有人」。';
      if (btn) {
        btn.className = 'btn btn-outline btn-sm';
        btn.textContent = '⚙️ 檢查試算表設定';
      }
    }
  } else {
    // online / normal
    if (dot) dot.className = 'sync-dot online';
    if (text) text.textContent = message || `試算表已連線 (${formatCurrentTime()})`;
    if (banner) {
      banner.className = 'cloud-sync-banner connected';
      const icon = banner.querySelector('.banner-icon');
      const title = banner.querySelector('.banner-title');
      const desc = banner.querySelector('.banner-desc');
      const btn = banner.querySelector('button');
      if (icon) icon.textContent = '🟢';
      if (title) title.textContent = '已連線 Google 試算表：每 4 秒自動背景同步最新回覆';
      if (desc) desc.textContent = '成員在手機填寫的每筆回覆將直接存入您的試算表，統計看板與 LINE 快報會自動即時匯總。';
      if (btn) {
        btn.className = 'btn btn-secondary btn-sm';
        btn.textContent = '⚙️ 試算表設定';
      }
    }
  }
}

// 手動觸發同步
async function manualSync() {
  const spinIcon = document.getElementById('sync-spin-icon');
  spinIcon?.classList.add('spin');
  loadResponsesFromStorage();
  await pullFromCloud(true);
  spinIcon?.classList.remove('spin');
}

// 自 Google 試算表拉取資料
async function pullFromCloud(isManual = false) {
  if (isSyncing) return;

  const hasGas = !!(syncConfig.gasUrl && syncConfig.gasUrl.trim());
  if (!hasGas) {
    updateSyncStatusUI();
    if (isManual) {
      showToast('ℹ️ 目前為本機單機模式。若需跨手機即時同步，請連線 Google 試算表！');
      openCloudSettingsModal('sheet');
    }
    return;
  }

  isSyncing = true;
  if (isManual) {
    updateSyncStatusUI('syncing', '正在向 Google 試算表同步...');
  }

  try {
    const res = await fetch(syncConfig.gasUrl.trim(), {
      method: 'GET',
      redirect: 'follow'
    });

    if (res.ok) {
      const json = await res.json();
      if (json && (json.status === 'ok' || json.data !== undefined)) {
        const hasChange = mergeResponses(json.data || {});
        updateSyncStatusUI('online', `試算表已同步 (${formatCurrentTime()})`);
        if (isManual) {
          showToast(hasChange ? '🔄 已從 Google 試算表更新最新回覆！' : '✅ 資料已與 Google 試算表同步（最新狀態）！');
        }
        return;
      }
    }
    throw new Error('試算表回傳格式錯誤');
  } catch (err) {
    console.warn('Google 試算表讀取錯誤：', err);
    updateSyncStatusUI('offline', '試算表連線逾時');
    if (isManual) {
      showToast('⚠️ 無法連線至 Google 試算表，請檢查網址並確認部署權限已設為所有人');
    }
  } finally {
    isSyncing = false;
  }
}

// 推送回覆至 Google 試算表
async function pushToCloud(singleMemberData = null) {
  const hasGas = !!(syncConfig.gasUrl && syncConfig.gasUrl.trim());
  if (!hasGas) {
    updateSyncStatusUI();
    return;
  }

  try {
    updateSyncStatusUI('syncing', '正在上傳至 Google 試算表...');
    const dataToSend = singleMemberData || Object.values(responsesState)[0];
    if (dataToSend) {
      await fetch(syncConfig.gasUrl.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'submit',
          data: dataToSend
        }),
        redirect: 'follow'
      });
    }
    updateSyncStatusUI('online', `已寫入 Google 試算表 (${formatCurrentTime()})`);
  } catch (err) {
    console.warn('Google 試算表推送異常：', err);
    updateSyncStatusUI('offline', '本機已存 (試算表未連上)');
  }
}

// 測試 Google Apps Script 連線
async function testGoogleAppsScriptConnection(url) {
  const resultEl = document.getElementById('gas-test-result');
  if (!resultEl) return;

  resultEl.style.display = 'block';

  if (!url || !url.startsWith('http')) {
    resultEl.style.color = '#f87171';
    resultEl.textContent = '❌ 請先貼入完整的 Apps Script 網址 (https://script.google.com/...)';
    return;
  }

  resultEl.style.color = '#fbbf24';
  resultEl.textContent = '⏳ 正在測試與試算表通訊...';

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow'
    });
    if (res.ok) {
      const json = await res.json();
      if (json && (json.status === 'ok' || json.data !== undefined)) {
        const count = json.data ? Object.keys(json.data).length : 0;
        resultEl.style.color = '#34d399';
        resultEl.textContent = `✅ 連線成功！試算表目前已儲存 ${count} 筆回覆`;
        return;
      }
    }
    throw new Error('回傳不是預期的格式');
  } catch (err) {
    resultEl.style.color = '#f87171';
    resultEl.textContent = '❌ 連線失敗：請確認部署為「網頁應用程式」且「誰可以存取：所有人」';
  }
}

// 合併雲端與本地資料（依更新時間較新者為準）
function mergeResponses(cloudData) {
  if (!cloudData || typeof cloudData !== 'object') return false;
  let changed = false;

  Object.keys(cloudData).forEach(rawKey => {
    const remote = cloudData[rawKey];
    if (!remote) return;

    const name = normalizeMemberName(remote.name || rawKey);
    const normalizedRemote = { ...remote, name };

    const local = responsesState[name];
    if (!local) {
      responsesState[name] = normalizedRemote;
      changed = true;
    } else {
      const remoteTime = new Date(normalizedRemote.updatedAt || 0).getTime();
      const localTime = new Date(local.updatedAt || 0).getTime();
      if (remoteTime > localTime) {
        responsesState[name] = normalizedRemote;
        changed = true;
      }
    }
  });

  if (changed) {
    saveResponsesToStorage(false);
    renderAll();
  }
  return changed;
}

// 剪貼簿通用相容複製
function executeClipboardCopy(text, successMsg = '已複製到剪貼簿！') {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg);
    }).catch(() => {
      fallbackCopyText(text, successMsg);
    });
  } else {
    fallbackCopyText(text, successMsg);
  }
}

function fallbackCopyText(text, successMsg) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(ta);
    if (successful) {
      showToast(successMsg);
      return;
    }
  } catch (e) {}

  showToast('📋 已開啟快報預覽，可點擊「全選文字」複製！');
}

// 分享問卷網址
function copyShareUrl() {
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();
  if (syncConfig.gasUrl) params.set('gas', syncConfig.gasUrl);
  if (syncConfig.roomId) params.set('room', syncConfig.roomId);
  
  const shareUrl = `${baseUrl}?${params.toString()}`;
  executeClipboardCopy(shareUrl, '🔗 已複製同試算表問卷網址！分享到 LINE 群組即可多人即時同步');
}

// ==================== 雲端設定彈窗邏輯 ====================
function openCloudSettingsModal(defaultTab = 'sheet') {
  const modal = document.getElementById('cloud-settings-modal');
  const inputRoom = document.getElementById('setting-room-id');
  const inputGas = document.getElementById('setting-gas-url');
  const testResult = document.getElementById('gas-test-result');

  if (inputRoom) inputRoom.value = syncConfig.roomId || 'club-survey-2026';
  if (inputGas) inputGas.value = syncConfig.gasUrl || '';
  if (testResult) {
    testResult.textContent = '';
    testResult.style.display = 'none';
  }

  // 切換至指定分頁（預設直接開啟 Google 試算表設定頁）
  const tabBtns = document.querySelectorAll('.settings-tab-btn');
  tabBtns.forEach(b => {
    if (b.getAttribute('data-settings-tab') === defaultTab) {
      b.click();
    }
  });

  modal?.classList.remove('hidden');

  // 打開時重設內部滾動位置至頂部，確保完整閱讀步驟
  const scrollBody = modal?.querySelector('.modal-scroll-body');
  if (scrollBody) scrollBody.scrollTop = 0;
}

function closeCloudSettingsModal() {
  document.getElementById('cloud-settings-modal')?.classList.add('hidden');
}

function initCloudSettingsEvents() {
  const modal = document.getElementById('cloud-settings-modal');
  const closeBtn = document.getElementById('cloud-settings-close');
  const cancelBtn = document.getElementById('btn-cancel-settings');
  const saveBtn = document.getElementById('btn-save-settings');

  closeBtn?.addEventListener('click', closeCloudSettingsModal);
  cancelBtn?.addEventListener('click', closeCloudSettingsModal);
  modal?.addEventListener('click', (e) => {
    if (e.target.id === 'cloud-settings-modal') closeCloudSettingsModal();
  });

  // 橫幅上的連線按鈕
  document.getElementById('btn-banner-connect-cloud')?.addEventListener('click', () => {
    openCloudSettingsModal('sheet');
  });

  // 測試連線按鈕
  document.getElementById('btn-test-gas-conn')?.addEventListener('click', () => {
    const url = document.getElementById('setting-gas-url')?.value.trim();
    testGoogleAppsScriptConnection(url);
  });

  // 設定分頁切換
  const tabBtns = document.querySelectorAll('.settings-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-settings-tab');

      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      document.getElementById(`tab-settings-${target}`)?.classList.add('active');

      // 切換分頁時重設滾動位置至頂部
      const scrollBody = modal?.querySelector('.modal-scroll-body');
      if (scrollBody) scrollBody.scrollTop = 0;
    });
  });

  // 複製 Google Apps Script 腳本按鈕（附帶按鈕即時動態回饋）
  document.getElementById('btn-copy-gas-code')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const code = document.getElementById('gas-script-code')?.textContent || '';
    executeClipboardCopy(code, '📋 已複製 Google Apps Script 腳本代碼！');

    if (btn) {
      const originalText = btn.innerHTML;
      btn.innerHTML = '✅ 已成功複製腳本代碼！';
      btn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.style.background = '';
      }, 2500);
    }
  });

  // 複製分享網址按鈕
  document.getElementById('btn-copy-share-url')?.addEventListener('click', copyShareUrl);

  // 匯出同步代碼
  document.getElementById('btn-export-sync-code')?.addEventListener('click', () => {
    const area = document.getElementById('setting-sync-code-area');
    if (area) {
      area.value = JSON.stringify(responsesState, null, 2);
      area.select();
      showToast('📤 最新代碼已匯出至文字框，可複製備份！');
    }
  });

  // 匯入同步代碼
  document.getElementById('btn-import-sync-code')?.addEventListener('click', () => {
    const area = document.getElementById('setting-sync-code-area');
    if (!area || !area.value.trim()) {
      showToast('⚠️ 請先在框內貼上 JSON 格式的同步代碼');
      return;
    }
    try {
      const parsed = JSON.parse(area.value.trim());
      const changed = mergeResponses(parsed);
      saveResponsesToStorage(true);
      pushToCloud();
      showToast(changed ? '📥 已成功匯入並合併填寫資料！' : '✅ 匯入成功（無新資料變動）');
    } catch (e) {
      showToast('⚠️ 代碼格式錯誤，必須為合法的 JSON 格式！');
    }
  });

  // 儲存設定
  saveBtn?.addEventListener('click', () => {
    const roomVal = document.getElementById('setting-room-id')?.value.trim() || 'club-survey-2026';
    const gasVal = document.getElementById('setting-gas-url')?.value.trim() || '';

    syncConfig.roomId = roomVal;
    syncConfig.gasUrl = gasVal;
    saveSyncConfig();

    closeCloudSettingsModal();
    updateSyncStatusUI();
    showToast(gasVal ? '💾 試算表設定已儲存！正在同步...' : '💾 設定已儲存（本機模式）');
    if (gasVal) {
      pullFromCloud(true);
    }
  });
}

// ==================== 示範資料產生 ====================
function loadMockData() {
  const confirmLoad = confirm('確定要載入隨機示範填寫資料嗎？這將為名冊中的大部分夥伴生成模擬回覆，方便您預覽所有圖表與統計效果。');
  if (!confirmLoad) return;

  const mockSamples = [
    {
      name: '黃○仁',
      willingness: 'high',
      clubs: ['戲劇社', '合唱團'],
      timeSlots: ['星期三 晚上', '星期六 晚上'],
      otherTime: '',
      notes: '很想挑戰看看即興演出！'
    },
    {
      name: '吳○德',
      willingness: 'high',
      clubs: ['樂器'],
      timeSlots: ['星期五 晚上', '星期六 早上'],
      otherTime: '吉他彈唱為主',
      notes: '有學過木吉他基礎。'
    },
    {
      name: '林○宏',
      willingness: 'medium',
      clubs: ['廚藝'],
      timeSlots: ['星期二 晚上', '星期日 晚上'],
      otherTime: '',
      notes: '想學甜點跟義大利麵。'
    },
    {
      name: '林○淞',
      willingness: 'high',
      clubs: ['戲劇社', '樂器'],
      timeSlots: ['星期一 晚上', '星期三 晚上', '星期五 晚上'],
      otherTime: '',
      notes: '平日晚上都能配合！'
    },
    {
      name: '許○宸',
      willingness: 'high',
      clubs: ['合唱團'],
      timeSlots: ['星期四 晚上', '星期六 晚上'],
      otherTime: '',
      notes: ''
    },
    {
      name: '陳○安',
      willingness: 'high',
      clubs: ['廚藝', '樂器'],
      timeSlots: ['星期六 早上', '星期日 早上'],
      otherTime: '週末早晨很適合',
      notes: '希望能有實作體驗。'
    },
    {
      name: '唐○睿',
      willingness: 'low',
      clubs: [],
      timeSlots: [],
      otherTime: '',
      notes: '最近工作較忙暫時無法出席，先祝大家開課順利！'
    },
    {
      name: '羅○菘',
      willingness: 'high',
      clubs: ['合唱團', '戲劇社'],
      timeSlots: ['星期三 晚上', '星期五 晚上', '星期六 晚上'],
      otherTime: '',
      notes: '喜歡音樂劇類型！'
    },
    {
      name: '李○慈',
      willingness: 'high',
      clubs: ['廚藝'],
      timeSlots: ['星期六 早上', '星期日 早上'],
      otherTime: '',
      notes: '廚藝讚讚！'
    },
    {
      name: '余○彤',
      willingness: 'medium',
      clubs: ['樂器', '合唱團'],
      timeSlots: ['星期五 晚上', '星期日 晚上'],
      otherTime: '雙週一次比較不緊湊',
      notes: '看最終時間安排'
    },
    {
      name: '李○澄',
      willingness: 'high',
      clubs: ['戲劇社'],
      timeSlots: ['星期一 晚上', '星期三 晚上'],
      otherTime: '',
      notes: ''
    },
    {
      name: '許○琳',
      willingness: 'high',
      clubs: ['廚藝', '戲劇社'],
      timeSlots: ['星期二 晚上', '星期六 早上'],
      otherTime: '',
      notes: '兩個都很想參加～'
    },
    {
      name: '許○碩',
      willingness: 'high',
      clubs: ['樂器'],
      timeSlots: ['星期五 晚上', '星期六 晚上'],
      otherTime: '',
      notes: '可以帶電吉他來！'
    },
    {
      name: '林○婷',
      willingness: 'medium',
      clubs: ['合唱團'],
      timeSlots: ['星期四 晚上'],
      otherTime: '',
      notes: ''
    },
    {
      name: '唐○惞',
      willingness: 'high',
      clubs: ['戲劇社', '合唱團'],
      timeSlots: ['星期五 晚上', '星期六 晚上'],
      otherTime: '',
      notes: '期待和大家一起排練！'
    },
    {
      name: '高○庭',
      willingness: 'high',
      clubs: ['廚藝'],
      timeSlots: ['星期六 早上', '星期六 晚上'],
      otherTime: '',
      notes: '想學常備菜烹調'
    }
  ];

  const now = new Date();
  mockSamples.forEach((item, idx) => {
    const time = new Date(now.getTime() - (idx * 3600000));
    const timeStr = `${time.getFullYear()}/${(time.getMonth()+1).toString().padStart(2, '0')}/${time.getDate().toString().padStart(2, '0')} ${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;

    responsesState[item.name] = {
      name: item.name,
      willingness: item.willingness,
      willingnessText: WILLINGNESS_MAP[item.willingness]?.text || '',
      clubs: item.clubs,
      timeSlots: item.timeSlots,
      otherTime: item.otherTime,
      notes: item.notes,
      updatedAt: timeStr
    };
  });

  saveResponsesToStorage(true);
  renderAll();
  pushToCloud();
  showToast('🎲 已成功載入 15 筆示範填寫資料！');
}

// ==================== 清空所有資料 ====================
function clearAllData() {
  const confirmClear = confirm('⚠️ 確定要清除所有填寫資料嗎？此操作無法復原。');
  if (!confirmClear) return;

  responsesState = {};
  saveResponsesToStorage(true);
  pushToCloud();
  resetForm();
  renderAll();
  showToast('🗑️ 所有填寫紀錄已清空');
}

// ==================== Toast 提示輔助 ====================
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3200);
}

// ==================== XSS 防護 ====================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
