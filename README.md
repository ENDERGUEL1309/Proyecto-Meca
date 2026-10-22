# Meca 3D — modelador web de terreno y edificaciones

Marca una zona en el mapa y obtén su modelo 3D: **relieve real**, **imagen satelital**, **edificios y vías de OpenStreetMap**, y encima **tus propios datos** (DEM/LiDAR, planos, fotos de campo y modelos 3D). Todo corre en el navegador con Three.js, sin backend ni API keys, y se exporta a **GLB**.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # pruebas unitarias (vitest)
npm run build    # sitio estático en dist/
```

## Flujo

1. **Zona**: busca un lugar (Nominatim) y dibuja un rectángulo o usa la vista actual. El máximo es 16 km² y a partir de 4 km² sale un aviso.
2. **Fuentes**: terreno global y/o tu DEM, la textura que quieras (satélite, mapa vectorial OSM o color liso), y edificios y vías.
3. **Generar**: el terreno, la imagen y los datos de OSM se descargan en paralelo y se construye la escena.
4. **Editar**: haz clic en un edificio para ver sus etiquetas OSM, corregir su altura y su base, u ocultarlo.
5. **Tus aportes**:
   - **Planos / mapeos previos** (imagen): se drapean sobre el relieve y se ajustan con desplazamiento, ancho, giro y opacidad.
   - **Fotos de campo**: si traen GPS en EXIF se colocan solas, y si traen `GPSImgDirection` se orientan hacia donde miraba la cámara. Si no tienen GPS, las colocas con un clic.
   - **Modelos 3D** (GLB/glTF de fotogrametría, BIM, SketchUp, Blender…): se apoyan en el terreno y se ajustan con giro, escala y elevación.
6. **Navegar**: arrastra para mover, clic derecho o dos dedos para girar, rueda o pellizco para el zoom. El punto de giro no sale de la zona y la cámara no atraviesa el terreno. Los botones de la esquina sirven para centrar, ver desde arriba, acercar y alejar.
7. **Sol y sombras**: eliges fecha y hora y el sol se coloca en su posición astronómica real, útil para estudios de soleamiento.
8. **Exportar**: GLB con terreno, zócalo, edificios, vías y modelos importados. La georreferencia (origen lat/lng/cota y bbox) va en `extras` del nodo raíz. También hay captura PNG.

## Fuentes de datos

| Capa | Fuente | Notas |
|---|---|---|
| Elevación global | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium) | ~30 m en casi todo el mundo, mejor donde hay fuentes nacionales. Sin API key. |
| Elevación propia | GeoTIFF del usuario (LiDAR, MDT nacional como el del IGN/CNIG, dron) | EPSG 4326, 3857, UTM WGS84 (326xx/327xx) y ETRS89 (258xx). Tiene prioridad sobre la global donde hay dato. |
| Imagen | Esri World Imagery | Hasta zoom 19. Revisa sus [términos de uso](https://www.esri.com/en-us/legal/terms/full-master-agreement) si el uso es comercial. |
| Edificios, vías, agua, zonas verdes | OpenStreetMap vía Overpass (con 3 servidores de respaldo) | ODbL: hay que citar a los colaboradores de OSM. |
| Búsqueda | Nominatim | Uso moderado según su política. |

### Cómo se calcula la altura de los edificios ([Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings))

1. `height` (acepta `m`, `ft`, `10'6"` y coma decimal), si existe.
2. Si no, `building:levels` + `roof:levels` × altura por planta (3 m, configurable) + `roof:height`.
3. Si no, una altura típica según el tipo (`house`, `garage`, `apartments`, `church`…), o la altura por defecto configurable. Estos edificios estimados salen en **gris claro** para distinguirlos.
4. `min_height` / `building:min_level` elevan la base (voladizos, pasarelas).
5. Cuando hay `building:part`, el contorno general no se extruye; se dibujan las partes.
6. Se usan los colores `building:colour` / `roof:colour` cuando están etiquetados.
7. **Asiento en el terreno.** Los DEM globales (SRTM) son modelos de *superficie*: en ciudades y bosques incluyen techos y copas, y las casas quedarían enterradas en su propio relieve. Por eso, para cada edificio:
   - el suelo es un percentil bajo de las cotas de la planta y su entorno (calles, patios), robusto frente a valores anómalos;
   - el terreno de la planta y un margen se rebaja hacia ese suelo, como una excavación, con un máximo de 4 m (sin fosos ni acantilados);
   - si en pendiente el terreno sigue por encima, el edificio se eleva hasta 6 m, como las casas de ladera escalonadas.
8. Se omiten los polígonos `building=yes` sin altura que son enormes (> 15.000 m²) o que cruzan más de 10 m de desnivel: casi siempre son manzanas enteras mapeadas como un solo edificio.
9. Las teselas de elevación se decodifican en JavaScript (`fast-png`), sin pasar por `<canvas>`. Las cotas van codificadas en los bytes de color, y la protección anti-huellas de Brave (o la gestión de color de Safari) altera esos bytes: un byte de diferencia en el rojo son 256 m de error.
10. El DEM se limpia antes de usarlo: se acota la batimetría absurda de ríos y estuarios (p. ej. −424 m en el Guayas) y se eliminan los picos aislados.

## Realismo de la escena

- **Relieve**: el DEM global se interpola de forma bicúbica (Catmull–Rom), así que las laderas no muestran las aristas de las celdas de 30 m.
- **Cielo**: modelo atmosférico (Preetham) con nubes que sigue la posición real del sol. También genera el mapa de entorno (PMREM) que ilumina la escena y se refleja en el agua.
- **Edificios**:
  - Por defecto se dibujan con colores sólidos (cubierta más oscura que el muro) y aristas marcadas, para que cada volumen se distinga del terreno.
  - Con «Texturas en edificios», los tejados llevan la ortofoto proyectada y las fachadas tienen ventanas alineadas con cada planta.
  - Hay cubiertas a dos aguas, a cuatro aguas y piramidales cuando lo indica `roof:shape`, y opcionalmente en casas pequeñas.
- **Agua**: los lagos, esteros y embalses tienen una lámina plana con oleaje y reflejos, a la cota de su orilla. Debajo, el terreno se rebaja 1,5 m para que el ruido del DEM sobre el agua no la tape. Los ríos y canales son cintas.
- **Vías**: hay asfalto con línea central amarilla y bordes blancos, calles secundarias, aceras, caminos de tierra y vía férrea con traviesas.

## Arquitectura

```
src/
  geo/      mercator.ts (proyección y marco local en metros), polygon.ts (anillos, multipolígonos, recorte), sun.ts
  data/     terrain.ts (Terrarium, muestreo bilineal, capas), geotiff.ts (DEM del usuario + proj4),
            imagery.ts (ortomosaico), osm.ts (Overpass → entidades), heights.ts (reglas S3DB)
  scene/    viewer.ts (render bajo demanda, sombras), terrainMesh.ts (malla + zócalo), buildings.ts,
            roads.ts, mapTexture.ts (textura vectorial OSM), userContent.ts (planos, fotos, modelos), exporter.ts
  ui/       mapSelector.ts (Leaflet)
  main.ts   orquestación de la interfaz
```

**Rendimiento:**
- Todos los edificios van en **una sola malla** con color por vértice, y lo mismo las vías: pocas llamadas de dibujo aunque haya miles de edificios. La selección funciona con un índice de triángulos y búsqueda binaria.
- La vista solo se re-renderiza cuando algo cambia, así que la GPU está en reposo mientras no tocas nada.
- El terreno tiene como máximo 512 segmentos por lado, con celdas de al menos 2 m.
- La textura se exporta en JPEG dentro del GLB.

**Sistema de coordenadas de la escena:** metros, `x` = este, `y` = arriba, `-z` = norte, con el origen en el centro de la zona y en la cota mínima del terreno. Se basa en Web Mercator escalado por cos(lat), con un error despreciable en áreas de pocos km.

## Despliegue

`.github/workflows/pages.yml` compila y publica el sitio en GitHub Pages en cada push a `main`. Para activarlo: *Settings → Pages → Source: GitHub Actions*. El resultado es un sitio estático, así que también sirve en Netlify, Vercel o cualquier hosting.

## Hoja de ruta

- Más formas de cubierta (cúpula, mansarda, *skillion*) y esqueleto recto para plantas no rectangulares.
- Mar y costa (`natural=coastline`) y agua animada.
- **Fotogrametría desde fotos del usuario**: fotos → nube de puntos o malla con un servicio aparte (OpenDroneMap / COLMAP) o con *Gaussian Splatting*, y vuelta al visor como GLB o 3D Tiles. Hoy ya se pueden importar GLB generados con Polycam, RealityScan o Meshroom.
- **Planos en PDF/DXF** (pdf.js, dxf-parser) y georreferenciación por puntos de control en lugar de solo deslizadores.
- **Ortofoto propia** (GeoTIFF RGB de dron) como textura.
- **Teselado del terreno con LOD** (quadtree) y Web Workers para zonas grandes.
- **Ocultar automáticamente los edificios OSM** que quedan bajo un modelo importado.
- **Guardar/abrir proyectos** (JSON con zona, ajustes, correcciones de altura y aportes).
- **Exportar** a 3D Tiles, OBJ y STL (impresión 3D de maquetas).

## Licencia

MIT. Los datos tienen sus propias licencias: los de OSM son ODbL, y la imagen de Esri y la elevación están sujetas a sus términos.
