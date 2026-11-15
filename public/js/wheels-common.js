// Gardiennage des roues : ce qui est commun à la fiche du véhicule (bureau) et à la tablette de l'atelier.
export const SEASONS = [{ key: 'summer', label: 'Été', icon: 'sun' }, { key: 'winter', label: 'Hiver', icon: 'snowflake' }];
// Les quatre roues, dans l'ordre où on les voit en regardant le véhicule de dessus (avant en haut)
export const POSITIONS = [{ key: 'fl', label: 'Avant gauche' }, { key: 'fr', label: 'Avant droite' }, { key: 'rl', label: 'Arrière gauche' }, { key: 'rr', label: 'Arrière droite' }];
export const FIELDS = ['brand', 'size', 'replace_front', 'replace_rear', 'stored_at', 'location', 'notes'];

/** « avant », « arrière », « avant et arrière » — ou rien. */
export const replaceLabel = (s) => (s?.replace_front && s?.replace_rear ? 'avant et arrière' : s?.replace_front ? 'avant' : s?.replace_rear ? 'arrière' : '');
/** Champs modifiables d'un jeu de roues, tels que le formulaire les manipule (cases à cocher = vrai / faux). */
export const formOf = (s) => ({ brand: s?.brand || '', size: s?.size || '', replace_front: Boolean(s?.replace_front), replace_rear: Boolean(s?.replace_rear), stored_at: s?.stored_at || '', location: s?.location || '', notes: s?.notes || '' });
/** Ce qui a changé entre deux états du formulaire (seuls ces champs sont envoyés). */
export const changes = (now, base) => Object.fromEntries(FIELDS.filter((k) => (now[k] ?? '') !== (base[k] ?? '')).map((k) => [k, now[k] === '' ? null : now[k]]));
/** Saison dont on range les roues à cette période : au printemps et en été on range l'hiver, sinon l'été. */
export const seasonToStore = (d = new Date()) => (d.getMonth() >= 2 && d.getMonth() <= 7 ? 'winter' : 'summer');
export const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/**
 * Réduit une photo de téléphone ou de tablette (souvent 5 à 10 Mo) à une image JPEG de 1600 px au plus : l'envoi est
 * rapide même avec un Wi-Fi faible dans l'atelier, et la photo reste assez nette pour lire le flanc d'un pneu.
 */
export async function shrinkPhoto(file, max = 1600, quality = 0.82) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('Choisissez une photo');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error('Cette photo ne peut pas être lue. Reprenez-la avec l’appareil photo.'); });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    // déjà petite et dans un format courant : envoyée telle quelle
    if (scale === 1 && file.size < 600_000 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) throw new Error('Cette photo ne peut pas être préparée pour l’envoi. Réessayez.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
