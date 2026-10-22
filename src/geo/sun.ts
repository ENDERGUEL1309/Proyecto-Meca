/**
 * Posición aproximada del sol (precisión ~1°), suficiente para estudios de sombras.
 * Devuelve azimut (desde el norte, sentido horario) y altura en radianes.
 */
export function sunPosition(date: Date, lat: number, lng: number): { azimuth: number; altitude: number } {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // días desde J2000
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lng) * rad - ra);
  const phi = lat * rad;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI), altitude };
}
