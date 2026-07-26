# mftechar
Dashboard de OSINT (Open Source Intelligence) diseñado para la investigación de fuentes públicas argentinas. Sin API keys, sin costos, sin restricciones — solo datos públicos organizados para quien los necesita.
Datos Personales
Herramienta	               Descripción
CUIT	                       Consulta titular, estado fiscal y situación financiera (BCRA Central de Deudores) de cualquier CUIT argentino vía ARCA + BCRA
CUIT x DNI	               Calcula el CUIT a partir del DNI usando el algoritmo público de módulo 11 con prefijos 20/23/27/24; además consulta ARCA vía Puppeteer para obtener el nombre real del titular
Email	                       Busca filtraciones, brechas de seguridad y datos públicos asociados a una dirección de email
Teléfono	               Geolocaliza y obtiene información pública de líneas telefónicas argentinas (prefijo, operador, provincia, localidad)
Usuario	                       Escanea presencia de un username en redes sociales, foros y plataformas públicas
Sociedades (RNS)	       Consulta el Registro Nacional de Sociedades por CUIT o razón social para obtener datos de empresas y personas jurídicas
Wayback Machine	               Abre el historial de versiones archivadas de un dominio en Internet Archive

Datos Financieros
Herramienta	                Descripción
DDJJ	                        Busca declaraciones juradas de bienes personales de funcionarios públicos argentinos
BIN	                        Identifica emisor, tipo, marca, nivel y país de tarjetas de crédito/débito a partir de los primeros 6-8 dígitos
Crypto	                        Consulta saldo y transacciones de direcciones Bitcoin y Ethereum en blockchains públicas

Red y Dominios
Herramienta	                Descripción
CT Subdominios          	Extrae todos los subdominios de un dominio desde los registros públicos de Certificate Transparency (crt.sh)
DNS Deep	                Analiza registros DNS (MX, SPF, DMARC, DKIM) para evaluar seguridad del correo electrónico de un dominio
WHOIS	                        Obtiene datos de registro de un dominio: titular, fechas de creación/vencimiento, DNS servers
Nmap	                        Escanea puertos abiertos de una IP/dominio — intenta nmap -sS -sV, fallback a TCP scan Node.js (28 puertos comunes)
OpenVAS	                        Escanea vulnerabilidades conocidas por puerto abierto — intenta nmap --script vuln, fallback a detección heuristic por servicio (EternalBlue, BlueKeep, etc.)
Seguridad Web 

Herramienta	                Descripción
CMS Detector            	Detecta CMS (WordPress, Joomla, Drupal, Magento, PrestaShop, Shopify, Wix, Squarespace, Ghost) y tecnologías web (jQuery, React, Vue, Angular, Bootstrap) de cualquier sitio
Admin Panel Finder      	Prueba 35+ rutas comunes de panel de administración y reporta cuáles son accesibles públicamente
Security Headers	        Evalúa la seguridad HTTP de un sitio: verifica 10 headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, etc.) y analiza flags de cookies (Secure, HttpOnly, SameSite)

OSINT / Referencias
Herramienta	                Descripción
Dorks	                        Genera enlaces de búsqueda Google Dorks para investigación pública de nombres, emails o usuarios
Breach	                        Busca en bases de datos de filtraciones públicas si un email apareció en brechas de seguridad conocidas
Paste	                        Busca menciones de un email o usuario en Pastebin y plataformas de paste
EmailFinder	                Extrae direcciones de email públicas asociadas a un dominio mediante scraping

Stack: Node.js + Express · Frontend vanilla JS · Grid 3 columnas · 
Truncado automático de resultados · Proyectos con exportación a PDF · Sin dependencias externas de pago
