export function isMaskedUserName(value) {
  return /[*＊]{2,}/.test(String(value || ""));
}

export function visibleUserName(value, uid = 0) {
  const name = String(value || "").trim();
  if (name && !isMaskedUserName(name)) return name;
  return Number(uid) > 0 ? `用户${Number(uid)}` : "匿名观众";
}
