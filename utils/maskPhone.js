// utils/maskPhone.js
export const maskPhone = (number) => {
  if (!number) return '••••••••••';
  const cleaned = number.replace(/\D/g, ''); // strip non-digits
  if (cleaned.length < 4) return '••••';
  const first2 = cleaned.slice(0, 2);
  const last2  = cleaned.slice(-2);
  const dots   = '•'.repeat(cleaned.length - 4);
  return `+${first2}${dots}${last2}`;
  // e.g. 919876543289 → +91••••••••89
};

// utils/maskPhone.js — email masking
// Shows first 2 chars of local part + masked middle + last 2 chars + @domain hidden as ••••
// e.g. john.doe@example.com → jo••••oe@•••••••
export const maskEmail = (email) => {
  if (!email) return '••••••••••';
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return '••'.repeat(4); // not a valid email, hide it
  const local  = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  // mask local part
  let maskedLocal;
  if (local.length <= 2) {
    maskedLocal = '•'.repeat(local.length);
  } else {
    maskedLocal = local.slice(0, 2) + '•'.repeat(local.length - 4 < 1 ? 1 : local.length - 4) + local.slice(-2);
  }
  // mask domain: show TLD extension, hide the rest
  const dotIdx = domain.lastIndexOf('.');
  const maskedDomain = dotIdx > 0
    ? '•'.repeat(dotIdx) + domain.slice(dotIdx)  // e.g. •••••.com
    : '•'.repeat(domain.length);
  return `${maskedLocal}@${maskedDomain}`;
};