/* ETF 成交额追踪 — 前端逻辑（无依赖，纯静态） */
(function () {
  "use strict";

  var S = null;
  var byCode = {};
  var tcodes = [];
  var liveOK = false;
  var refreshing = false;
  var timer = null;
  var state = { sort: "ratio", group: "all", q: "" };
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    d = d === undefined ? 2 : d;
    return Number(n).toLocaleString("zh-CN", {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function signed(n, d) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return (n > 0 ? "+" : "") + fmt(n, d === undefined ? 2 : d);
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function toast(msg) {
    var el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 3200);
  }

  /* ---------- 时间 / 交易状态 ---------- */
  function bjParts() {
    var p = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short", hourCycle: "h23"
    }).formatToParts(new Date());
    var o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    return o;
  }

  function marketState() {
    var b = bjParts();
    var wd = b.weekday;
    var weekend = wd === "Sat" || wd === "Sun";
    var t = parseInt(b.hour, 10) * 60 + parseInt(b.minute, 10);
    var lunch = !weekend && t >= 690 && t < 780;                 // 11:30 - 13:00
    var trading = !weekend && ((t >= 570 && t < 690) || (t >= 780 && t < 900));
    var preopen = !weekend && t >= 540 && t < 570;               // 09:00 - 09:30
    var after = !weekend && t >= 900;
    var before = !weekend && t < 540;
    var prog;

    if (t < 570) prog = 0;
    else if (t <= 690) prog = (t - 570) / 240;
    else if (t < 780) prog = 120 / 240;
    else if (t < 900) prog = (120 + (t - 780)) / 240;
    else prog = 1;

    return {
      weekend: weekend, trading: trading, lunch: lunch, preopen: preopen,
      after: after, before: before,
      progress: clamp(prog, 0.12, 1),
      date: b.year + b.month + b.day,
      hhmm: b.hour + ":" + b.minute,
      effHHMM: lunch ? "11:30" : b.hour + ":" + b.minute,
      weekday: wd
    };
  }

  function hhmm2min(s) {
    if (!s) return 0;
    var p = String(s).split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function shapeAt(shape, hhmm) {
    if (!shape || !shape.length) return null;
    var tx = hhmm2min(hhmm);
    var first = shape[0], last = shape[shape.length - 1];
    if (tx <= hhmm2min(first[0])) return first[1];
    if (tx >= hhmm2min(last[0])) return last[1];
    for (var i = 1; i < shape.length; i++) {
      var t1 = hhmm2min(shape[i][0]);
      if (tx <= t1) {
        var t0 = hhmm2min(shape[i - 1][0]);
        if (t1 <= t0) return shape[i][1];
        return shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * (tx - t0) / (t1 - t0);
      }
    }
    return last[1];
  }

  function dayProgress(it, st) {
    if (!st) return 1;
    // 午休时行情锁定在 11:30，仍要按「半天进度」对齐，不能当成全天
    if (!st.trading && !st.lunch) return 1;
    var s = shapeAt(it.shape, st.effHHMM);
    if (s !== null && s > 0.02) return clamp(s, 0.02, 1);
    return st.progress || 0.5;
  }

  function calc(it, st) {
    var p = dayProgress(it, st);
    var base = it.avg20_yi || 0;
    var amt = it.amount_yi || 0;
    var oi = (it.outer_lots || 0) + (it.inner_lots || 0);
    return {
      p: p,
      ratio: base > 0 && p > 0 ? amt / (base * p) : 0,
      raw: base > 0 ? amt / base : 0,
      net: oi > 0 ? ((it.outer_lots - it.inner_lots) / oi) * amt : 0
    };
  }

  function ratioClass(r) {
    if (r >= 1.5) return "hot";
    if (r >= 1.1) return "warm";
    if (r > 0 && r <= 0.7) return "cool";
    return "";
  }

  function fmtDate(d) {
    if (!d || d.length !== 8) return d || "—";
    return d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8);
  }

  /* ---------- 渲染 ---------- */
  function coreList() {
    var core = S.items.filter(function (it) { return it.group === "core"; });
    return core.length ? core : S.items;
  }

  function renderVerdict(st) {
    var box = $("verdict");
    var list = coreList().filter(function (it) {
      return (it.avg20_yi || 0) > 0 && (it.amount_yi || 0) > 0;
    });

    if (!list.length) {
      box.className = "verdict flat";
      $("metrics").innerHTML = "";
      if (st && (st.preopen || st.before)) {
        $("vTitle").textContent = "等待开盘";
        $("vReason").textContent = "行情尚未开始，9:30 开盘后页面会自动刷新。";
      } else {
        $("vTitle").textContent = "暂无数据";
        $("vReason").textContent = "还没有可用的成交额数据，请先运行 python3 scripts/update_data.py。";
      }
      return;
    }

    var amt = 0, baseP = 0, hot = 0, cool = 0, ratios = [], netSum = 0, pSum = 0;
    for (var i = 0; i < list.length; i++) {
      var r = calc(list[i], st);
      amt += list[i].amount_yi || 0;
      baseP += (list[i].avg20_yi || 0) * r.p;
      netSum += r.net;
      pSum += r.p;
      if (r.ratio) ratios.push(r.ratio);
      if (r.ratio >= 1.3) hot++;
      else if (r.ratio > 0 && r.ratio <= 0.7) cool++;
    }

    var ratio = baseP > 0 ? amt / baseP : 0;
    var med = median(ratios);

    var title, cls;
    if (ratio >= 1.6) { title = "明显放量"; cls = "hot"; }
    else if (ratio >= 1.25) { title = "放量"; cls = "hot"; }
    else if (ratio <= 0.6) { title = "明显缩量"; cls = "cool"; }
    else if (ratio <= 0.8) { title = "缩量"; cls = "cool"; }
    else { title = "成交平稳"; cls = "flat"; }

    var prefix = (st.weekend || st.before || st.preopen) ? "最近交易日" : "今日";

    box.className = "verdict " + cls;
    $("vTitle").textContent = prefix + title;
    $("vReason").textContent =
      list.length + " 只核心宽基合计成交 " + fmt(amt, 1) + " 亿，为同时点 20 日均额的 " +
      fmt(ratio, 2) + " 倍；" + hot + " 只放量、" + cool + " 只缩量，中位数 " + fmt(med, 2) + " 倍。";

    var pAvg = pSum / list.length;
    var netCls = netSum > 0 ? "v-hot" : (netSum < 0 ? "v-cool" : "");

    $("metrics").innerHTML =
      metric("合计成交额", fmt(amt, 1) + "<span class=\"unit\"> 亿</span>", list.length + " 只核心宽基") +
      metric("同时点倍数", "<span class=\"" + (cls === "hot" ? "v-hot" : cls === "cool" ? "v-cool" : "") + "\">" +
        fmt(ratio, 2) + "×</span>", "历史同时点完成 " + Math.round(pAvg * 100) + "%") +
      metric("放量 / 缩量", hot + " <span class=\"slash\">/</span> " + cool, "倍数 ≥1.3 / ≤0.7") +
      metric("主动买卖差", "<span class=\"" + netCls + "\">" + signed(netSum, 1) + "</span><span class=\"unit\"> 亿</span>",
        "逐笔方向推算，非净流入");
  }

  function metric(k, v, n) {
    return "<div class=\"metric\"><div class=\"k\">" + k + "</div><div class=\"v num\">" + v +
      "</div><div class=\"n\">" + n + "</div></div>";
  }

  function spark(hist) {
    if (!hist || !hist.length) return "<span class=\"muted\">—</span>";
    var vals = hist.map(function (x) { return x.amount_yi || 0; });
    var max = Math.max.apply(null, vals) || 1;
    var w = 104, h = 30, bw = w / vals.length;
    var bars = "";
    for (var i = 0; i < vals.length; i++) {
      var bh = Math.max(1.5, vals[i] / max * h);
      var last = i === vals.length - 1;
      bars += "<rect x=\"" + (i * bw).toFixed(1) + "\" y=\"" + (h - bh).toFixed(1) +
        "\" width=\"" + Math.max(1.1, bw - 1).toFixed(1) + "\" height=\"" + bh.toFixed(1) +
        "\" rx=\"0.8\" fill=\"" + (last ? "#4f46e5" : "#dfe3ec") + "\"/>";
    }
    return "<svg class=\"spark\" width=\"" + w + "\" height=\"" + h + "\" viewBox=\"0 0 " + w + " " + h +
      "\" aria-hidden=\"true\">" + bars + "</svg>";
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = S.items.filter(function (it) {
      if (state.group !== "all" && it.group !== state.group) return false;
      if (!q) return true;
      return (it.code + "").indexOf(q) >= 0 || (it.name || "").toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (state.sort === "name") return String(a.name).localeCompare(String(b.name), "zh-CN");
      if (state.sort === "amount") return (b.amount_yi || 0) - (a.amount_yi || 0);
      if (state.sort === "pct") return (b.pct || 0) - (a.pct || 0);
      if (state.sort === "mktcap") return (b.mktcap_yi || 0) - (a.mktcap_yi || 0);
      return calc(b, lastState).ratio - calc(a, lastState).ratio;
    });
    return list;
  }

  var lastState = null;

  function renderTable(st) {
    lastState = st;
    var list = filtered();
    var tbody = $("tbody");

    if (!list.length) {
      tbody.innerHTML = "<tr><td colspan=\"9\" class=\"empty\">没有匹配的标的，换个关键词试试。</td></tr>";
    } else {
      var html = "";
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var r = calc(it, st);
        var rc = ratioClass(r.ratio);
        var pctCls = it.pct > 0 ? "up" : (it.pct < 0 ? "down" : "muted");
        var netCls = r.net > 0 ? "up" : (r.net < 0 ? "down" : "muted");
        var subCls = it.subscr_net_yi > 0 ? "up" : (it.subscr_net_yi < 0 ? "down" : "");

        html += "<tr>" +
          "<td><div class=\"etf-cell\"><span class=\"etf-name\">" + esc(it.name) +
            (it.group === "extended" ? "<span class=\"tag\">扩展</span>" : "") + "</span>" +
            "<span class=\"etf-meta\">" + esc(it.code) + " · " + esc(it.tcode.toUpperCase()) + "</span></div></td>" +
          "<td><span class=\"idx\">" + esc(it.index || "—") + "</span></td>" +
          "<td class=\"num\">" + fmt(it.mktcap_yi, 1) + "</td>" +
          "<td class=\"num\">" + fmt(it.amount_yi, 2) + "</td>" +
          "<td class=\"num\"><span class=\"ratio " + rc + "\">" + (r.ratio ? fmt(r.ratio, 2) + "×" : "—") + "</span>" +
            "<span class=\"raw\">日均 " + (r.raw ? fmt(r.raw, 2) + "×" : "—") + "</span></td>" +
          "<td class=\"num\"><span class=\"" + netCls + "\">" + signed(r.net, 2) + "</span></td>" +
          "<td class=\"num\"><span class=\"" + pctCls + "\">" + (it.pct > 0 ? "+" : "") + fmt(it.pct, 2) + "%</span></td>" +
          "<td class=\"num\">" + fmt(it.shares_yi, 1) +
            (it.subscr_net_yi === null || it.subscr_net_yi === undefined
              ? (it.shares_stale
                ? "<span class=\"sub\">份额源未日更</span>"
                : "<span class=\"sub\">较上日 —</span>")
              : "<span class=\"sub " + subCls + "\">申赎 " + signed(it.subscr_net_yi, 1) + " 亿</span>") + "</td>" +
          "<td class=\"num\">" + spark(it.hist) + "</td>" +
          "</tr>";
      }
      tbody.innerHTML = html;
    }

    var tradingTxt = st.trading ? "盘中数据每 20 秒刷新，" : "";
    $("listHint").textContent = "共 " + S.items.length + " 只 · " + tradingTxt + "同时点倍数越高代表相对 20 日均额越放量";
    $("tableNote").textContent =
      "份额为腾讯行情场内份额；申赎 =（本次快照份额 − 上一快照份额）× 现价，是估算值。" +
      "同一市场 ≥70% 的标的两日份额完全相同时，视为行情源未日更，不展示申赎数字。" +
      "主动买卖差 =（外盘 − 内盘）÷（外盘 + 内盘）× 成交额，仅为逐笔成交方向推算，不是资金净流入。";
  }

  function renderRank(st) {
    var list = S.items.map(function (it) {
      return { it: it, r: calc(it, st) };
    }).filter(function (x) {
      return x.r.ratio > 0;
    }).sort(function (a, b) {
      return b.r.ratio - a.r.ratio;
    }).slice(0, 9);

    var box = $("rank");
    if (!list.length) {
      box.innerHTML = "<p class=\"hint\">暂无数据。</p>";
      return;
    }

    var max = Math.max(1.5, list[0].r.ratio);
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var it = list[i].it, r = list[i].r.ratio;
      var rc = ratioClass(r);
      var width = clamp(r / max * 100, 1.5, 100);
      html += "<div class=\"rank-row\">" +
        "<div class=\"rank-name\"><b>" + esc(it.name) + "</b><span>" + esc(it.index || "") + " · " + esc(it.code) + "</span></div>" +
        "<div class=\"rank-track\">" +
          "<div class=\"rank-fill " + rc + "\" style=\"width:" + width.toFixed(1) + "%\"></div>" +
          "<div class=\"rank-tick\" style=\"left:" + (100 / max).toFixed(1) + "%\" title=\"1.0× 基准线\"></div>" +
        "</div>" +
        "<div class=\"rank-val " + (rc === "hot" ? "up" : rc === "cool" ? "down" : "") + "\">" + fmt(r, 2) + "×</div>" +
        "</div>";
    }
    box.innerHTML = html;
  }

  function renderStatus(st) {
    var pill = $("statusPill"), text = $("statusText");
    if (st.trading) {
      pill.className = "pill " + (liveOK ? "live" : "warn");
      text.textContent = liveOK ? "实时 · 20 秒刷新" : "实时通道不可用 · 显示快照";
    } else if (st.lunch) {
      pill.className = "pill " + (liveOK ? "live" : "");
      text.textContent = "午间休市 · 数据锁定 11:30";
    } else if (st.preopen) {
      pill.className = "pill";
      text.textContent = "等待开盘 · 9:30";
    } else if (st.after) {
      pill.className = "pill";
      text.textContent = "已收盘 · 今日复盘数据";
    } else if (st.weekend) {
      pill.className = "pill";
      text.textContent = "周末休市";
    } else {
      pill.className = "pill";
      text.textContent = "休市";
    }

    var newest = S.items.length ? (S.items[0].ts || "") : "";
    var tsTxt = newest && newest.length >= 14
      ? newest.slice(0, 4) + "-" + newest.slice(4, 6) + "-" + newest.slice(6, 8) + " " +
        newest.slice(8, 10) + ":" + newest.slice(10, 12) + ":" + newest.slice(12, 14)
      : "—";
    $("stamp").textContent = "行情 " + tsTxt + " · 快照 " + S.generated_at;
    $("vDate").textContent = fmtDate((S.trade_date || "").replace(/-/g, ""));

    var asof;
    if (st.lunch) asof = "午间休市 · 截至 11:30";
    else if (st.trading) asof = "截至 " + st.hhmm;
    else if (st.after) asof = "已收盘 · 全天口径";
    else if (st.weekend) asof = "休市 · 最近交易日";
    else asof = "开盘前";
    $("asofText").textContent = asof;

    $("sign").textContent =
      "数据来源：腾讯行情 + 新浪 5 分钟 K 线 · 快照生成 " + S.generated_at +
      " · 结论为量价推测，仅供研究，不构成投资建议。";
  }

  /* ---------- 份额图表 ---------- */
  var shareRange = 242;

  function shareSeries(n) {
    var H = S.shares_history || {};
    var dates = Object.keys(H).sort();
    if (dates.length < 2) return null;

    var core = S.items.filter(function (it) { return it.group === "core"; })
      .map(function (it) { return it.code; });
    if (!core.length) {
      core = Object.keys(H[dates[dates.length - 1]] || {});
    }
    if (!core.length) return null;

    var take = Math.max(2, Math.min(n + 1, dates.length));
    var wd = dates.slice(dates.length - take);
    var last = {}, series = [];

    for (var i = 0; i < wd.length; i++) {
      var row = H[wd[i]] || {};
      for (var j = 0; j < core.length; j++) {
        var c = core[j];
        if (row[c] !== undefined && row[c] !== null) last[c] = row[c];
      }
      var sum = 0, has = false;
      for (var k = 0; k < core.length; k++) {
        if (last[core[k]] !== undefined) { sum += last[core[k]]; has = true; }
      }
      series.push({ date: wd[i], total: has ? sum : null });
    }

    while (series.length && series[0].total === null) series.shift();
    if (series.length < 2) return null;

    var deltas = [];
    for (var m = 1; m < series.length; m++) {
      if (series[m].total !== null && series[m - 1].total !== null) {
        deltas.push({ date: series[m].date, d: series[m].total - series[m - 1].total });
      }
    }

    var base = series[0].total || 1;
    var idx = series.map(function (p) {
      return { date: p.date, v: p.total === null ? null : 100 * p.total / base };
    });

    return { series: series, deltas: deltas, idx: idx, base: base, count: core.length };
  }

  function niceCeil(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * p >= v) return steps[i] * p;
    }
    return 10 * p;
  }

  function axisDate(d, big) {
    if (!d || d.length !== 8) return d || "";
    return big ? d.slice(2, 4) + "/" + d.slice(4, 6) : d.slice(4, 6) + "-" + d.slice(6, 8);
  }

  function axisLabels(dates, xOf, y, big) {
    var n = dates.length;
    var picks = [0, Math.round((n - 1) / 3), Math.round(2 * (n - 1) / 3), n - 1];
    var seen = {}, out = "";
    for (var i = 0; i < picks.length; i++) {
      var k = picks[i];
      if (seen[k]) continue;
      seen[k] = 1;
      out += '<text x="' + xOf(k).toFixed(1) + '" y="' + y + '" text-anchor="' +
        (k === 0 ? "start" : k === n - 1 ? "end" : "middle") +
        '" font-size="10" fill="#8b93a1">' + axisDate(dates[k], big) + "</text>";
    }
    return out;
  }

  function deltaChart(deltas) {
    var W = 560, H = 190, L = 44, R = 8, T = 12, B = 26;
    var pw = W - L - R, ph = H - T - B;
    var maxAbs = 0;
    for (var i = 0; i < deltas.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(deltas[i].d));
    }
    maxAbs = niceCeil(maxAbs || 1);
    var mid = T + ph / 2;
    var bw = pw / deltas.length;
    var bars = "", grid = "";

    [-maxAbs, 0, maxAbs].forEach(function (v) {
      var y = mid - v / maxAbs * (ph / 2);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) +
        '" y2="' + y.toFixed(1) + '" stroke="' + (v === 0 ? "#d9dee8" : "#eef1f6") +
        '" stroke-width="1"' + (v === 0 ? "" : ' stroke-dasharray="3 3"') + "/>";
      grid += '<text x="' + (L - 6) + '" y="' + (y + 3.5).toFixed(1) +
        '" text-anchor="end" font-size="9.5" fill="#8b93a1">' + fmt(v, 0) + "</text>";
    });

    for (var j = 0; j < deltas.length; j++) {
      var p = deltas[j], v = p.d;
      var h = Math.abs(v) / maxAbs * (ph / 2);
      var x = L + j * bw + bw * 0.18;
      var w = Math.max(1, bw * 0.64);
      var y = v >= 0 ? mid - h : mid;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
        '" height="' + Math.max(0.8, h).toFixed(1) + '" rx="1" fill="' +
        (v >= 0 ? "#e11d48" : "#0e9f6e") + '" opacity="' + (v >= 0 ? 0.82 : 0.78) +
        '"><title>' + p.date + "  " + signed(v, 1) + " 亿份</title></rect>";
    }

    var big = deltas.length > 1 && deltas[0].date.slice(0, 4) !== deltas[deltas.length - 1].date.slice(0, 4);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="每日份额变化">' +
      grid + bars + axisLabels(deltas.map(function (p) { return p.date; }),
        function (i) { return L + i * bw + bw / 2; }, H - 8, big) + "</svg>";
  }

  function indexChart(idx) {
    var pts = idx.filter(function (p) { return p.v !== null; });
    if (pts.length < 2) return "";
    var W = 560, H = 190, L = 44, R = 8, T = 12, B = 26;
    var pw = W - L - R, ph = H - T - B;
    var vals = pts.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = (hi - lo) * 0.1 || 1;
    var min = lo - pad, max = hi + pad;
    var n = pts.length;

    function x(i) { return L + i / (n - 1) * pw; }
    function y(v) { return T + ph - (v - min) / (max - min) * ph; }

    var path = "";
    for (var i = 0; i < n; i++) {
      path += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(pts[i].v).toFixed(1);
    }
    var area = path + " L" + x(n - 1).toFixed(1) + "," + (T + ph) + " L" + L + "," + (T + ph) + " Z";

    var grid = "";
    [lo, (lo + hi) / 2, hi].forEach(function (v) {
      var yy = y(v);
      grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy.toFixed(1) +
        '" y2="' + yy.toFixed(1) + '" stroke="#eef1f6" stroke-width="1"/>';
      grid += '<text x="' + (L - 6) + '" y="' + (yy + 3.5).toFixed(1) +
        '" text-anchor="end" font-size="9.5" fill="#8b93a1">' + fmt(v, 1) + "</text>";
    });

    var baseline = "";
    if (100 >= min && 100 <= max) {
      var by = y(100);
      baseline = '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + by.toFixed(1) +
        '" y2="' + by.toFixed(1) + '" stroke="#c7ccd8" stroke-width="1" stroke-dasharray="4 3"/>';
    }

    var big = pts[0].date.slice(0, 4) !== pts[n - 1].date.slice(0, 4);
    var last = pts[n - 1];
    var label = '<text x="' + (W - R) + '" y="' + (T + 8) + '" text-anchor="end" font-size="10" fill="#4f46e5" font-weight="700">' +
      fmt(last.v, 1) + "</text>";

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="加仓指数">' +
      '<defs><linearGradient id="idxFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4f46e5" stop-opacity="0.18"/>' +
      '<stop offset="100%" stop-color="#4f46e5" stop-opacity="0"/></linearGradient></defs>' +
      grid + baseline +
      '<path d="' + area + '" fill="url(#idxFill)"/>' +
      '<path d="' + path + '" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + x(n - 1).toFixed(1) + '" cy="' + y(last.v).toFixed(1) + '" r="3.2" fill="#4f46e5"/>' +
      '<circle cx="' + x(n - 1).toFixed(1) + '" cy="' + y(last.v).toFixed(1) + '" r="3.2" fill="none" stroke="#fff" stroke-width="1.5"/>' +
      label +
      axisLabels(pts.map(function (p) { return p.date; }), x, H - 8, big) + "</svg>";
  }

  function renderShareCharts() {
    var deltaEl = $("chartDelta"), idxEl = $("chartIndex");
    if (!deltaEl || !idxEl) return;
    var data = shareSeries(shareRange);

    if (!data || !data.deltas.length) {
      var empty = '<div class="chart-empty">还没有足够的份额历史。<br>先运行 ' +
        "<code>python3 scripts/fetch_shares.py --days 400</code> 回填。</div>";
      deltaEl.innerHTML = empty;
      idxEl.innerHTML = empty;
      $("shareHint").textContent = "等待份额历史（Tushare）";
      $("chartNote").textContent = "份额历史来自 Tushare fund_share；未配置 token 时只显示腾讯当日快照。";
      return;
    }

    deltaEl.innerHTML = deltaChart(data.deltas);
    idxEl.innerHTML = indexChart(data.idx);

    var first = data.series[0], last = data.series[data.series.length - 1];
    $("shareHint").textContent = "核心 " + data.count + " 只 · " +
      fmtDate(first.date) + " ~ " + fmtDate(last.date);
    $("chartNote").textContent =
      "核心宽基合计份额（亿份）· 每日变化 = 当日份额 − 前一交易日；正数净申购、负数净赎回。" +
      "加仓指数 = 区间首日归一为 100 · 数据：Tushare fund_share（万份换算）。";
  }

  function renderAll() {
    if (!S) return;
    var st = marketState();
    renderVerdict(st);
    renderTable(st);
    renderRank(st);
    renderShareCharts();
    renderStatus(st);
  }

  /* ---------- 实时行情（JSONP 方式，绕开 CORS） ---------- */
  function applyLive() {
    var got = 0;
    for (var i = 0; i < tcodes.length; i++) {
      var tc = tcodes[i];
      var raw = window["v_" + tc];
      if (!raw) continue;
      var f = raw.split("~");
      var it = byCode[f[2]];
      if (!it) continue;

      var price = parseFloat(f[3]) || 0;
      var amountWan = parseFloat(f[37]) || 0;
      var shares = parseFloat(f[72]) || parseFloat(f[73]) || parseFloat(f[76]) || 0;

      it.price = price;
      it.prev_close = parseFloat(f[4]) || it.prev_close;
      it.pct = parseFloat(f[32]) || 0;
      it.amount_yi = amountWan / 1e4;
      it.outer_lots = parseFloat(f[7]) || 0;
      it.inner_lots = parseFloat(f[8]) || 0;
      it.turnover = parseFloat(f[38]) || 0;
      it.mktcap_yi = parseFloat(f[45]) || it.mktcap_yi;
      it.ts = f[30] || it.ts;
      if (f[30] && f[30].length >= 8) it.date = f[30].slice(0, 8);
      if (shares > 0) {
        it.shares = shares;
        it.shares_yi = shares / 1e8;
        if (it.prev_shares_yi && price) {
          // 份额快照只保留 4 位小数，误差小于 0.0001 亿份（1 万股）视为没变化
          var prevYi = it.prev_shares_yi;
          var nextYi = shares / 1e8;
          if (Math.abs(nextYi - prevYi) >= 0.0001) {
            it.subscr_net_yi = Math.round((nextYi - prevYi) * price * 100) / 100;
            it.shares_stale = false;
          } else if (!it.shares_stale) {
            it.subscr_net_yi = 0;
          }
        }
      }
      got++;
    }
    return got > 0;
  }

  function refresh(manual) {
    if (!tcodes.length || refreshing) return;
    refreshing = true;
    var btn = $("refresh");
    btn.disabled = true;
    btn.textContent = "更新中…";

    var done = false;
    var tm = null;
    var url = "https://qt.gtimg.cn/q=" + tcodes.join(",") + "&r=" + Date.now();

    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(tm);
      liveOK = ok && applyLive();
      refreshing = false;
      btn.disabled = false;
      btn.textContent = "刷新";
      renderAll();
      if (manual && !liveOK) toast("实时行情暂时不可用，当前显示快照数据");
      try { s.parentNode && s.parentNode.removeChild(s); } catch (e) {}
    }

    var s = document.createElement("script");
    s.async = true;
    s.onload = function () { finish(true); };
    s.onerror = function () { finish(false); };
    tm = setTimeout(function () { finish(false); }, 8000);
    s.src = url;
    document.head.appendChild(s);
  }

  function schedule() {
    clearTimeout(timer);
    var st = marketState();
    var wait = st.trading ? 20000 : 60000;
    timer = setTimeout(function () {
      if ($("auto").checked && marketState().trading) refresh(false);
      schedule();
    }, wait);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    S = window.SNAPSHOT;
    if (!S || !S.items || !S.items.length) return showError();

    for (var i = 0; i < S.items.length; i++) {
      byCode[S.items[i].code] = S.items[i];
      tcodes.push(S.items[i].tcode);
    }

    document.title = (S.title || "ETF 成交额追踪") + " · 今日放量了吗";
    renderAll();
    refresh(false);
    schedule();
    setInterval(function () { renderStatus(marketState()); }, 30000);
  }

  function showError() {
    $("vTitle").textContent = "数据快照加载失败";
    $("vReason").textContent = "请先在项目目录运行 python3 scripts/update_data.py 生成 data/snapshot.js，然后刷新页面。";
    $("statusText").textContent = "无数据";
    $("statusPill").className = "pill warn";
    $("tbody").innerHTML = "<tr><td colspan=\"9\" class=\"empty\">没有可展示的数据。</td></tr>";
  }

  function loadSnapshot() {
    var s = document.createElement("script");
    s.src = "data/snapshot.js?t=" + Date.now();
    s.onload = function () {
      if (window.SNAPSHOT) boot();
      else showError();
    };
    s.onerror = showError;
    document.head.appendChild(s);
  }

  /* ---------- 事件 ---------- */
  $("q").addEventListener("input", function () { state.q = this.value; renderTable(marketState()); });
  $("group").addEventListener("change", function () { state.group = this.value; renderTable(marketState()); });
  $("sort").addEventListener("change", function () { state.sort = this.value; renderTable(marketState()); });
  $("refresh").addEventListener("click", function () { refresh(true); });
  $("auto").addEventListener("change", function () {
    if (!this.checked) clearTimeout(timer);
    schedule();
  });

  var rangeEl = $("shareRange");
  if (rangeEl) {
    rangeEl.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button") : null;
      if (!btn || !this.contains(btn)) return;
      var n = parseInt(btn.getAttribute("data-n"), 10);
      if (!n) return;
      shareRange = n;
      var btns = this.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("on", btns[i] === btn);
      }
      renderShareCharts();
    });
  }

  loadSnapshot();
})();
