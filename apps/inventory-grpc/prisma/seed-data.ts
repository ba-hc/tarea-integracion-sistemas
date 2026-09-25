// Catálogo inicial de Inventory. Los UUID son fijos a propósito: Sales, las
// pruebas de sistema, la demo y el experimento RS-402 pueden referenciar las
// mismas piezas en cualquier máquina después de `docker compose up --build`.
// No cambiar un UUID existente; para agregar piezas, agregar filas nuevas.

export interface SeedPart {
  id: string;
  sku: string;
  name: string;
  stockAvailable: number;
}

/**
 * Pieza reservada para el experimento de timeout (RS-402). Stock alto para
 * que el barrido de ~10.000 órdenes por brazo no agote el inventario.
 * No usarla en la demo ni en pruebas funcionales.
 */
export const EXPERIMENT_PART_ID = '0be383fa-f9d8-4eb9-87ec-2e528faf83eb';

/**
 * Pieza reservada para las pruebas de sistema (RS-401, PART_WITH_STOCK). Stock
 * bajo y conocido: la suite lo consume entero y lo repone al terminar.
 * No usarla en la demo ni en el experimento.
 */
export const SYSTEM_TEST_PART_ID = 'e58e2904-9db7-4c8d-8f36-7107e863a268';
export const SYSTEM_TEST_PART_STOCK = 5;

export const SEED_PARTS: readonly SeedPart[] = [
  // Frenos
  { id: '3224288d-5201-477a-aa99-cb7cd1ba628d', sku: 'FRN-PAS-DEL-001', name: 'Pastillas de freno delanteras cerámicas', stockAvailable: 40 },
  { id: 'b4546a50-991d-47ae-b9bb-56bf0ecd1c41', sku: 'FRN-PAS-TRA-002', name: 'Pastillas de freno traseras semimetálicas', stockAvailable: 35 },
  { id: '6131cf5e-9788-4b0a-85b7-1633b46ef95d', sku: 'FRN-DIS-DEL-003', name: 'Disco de freno delantero ventilado 280 mm', stockAvailable: 18 },
  { id: '8829afb4-e3cd-496a-ab14-bc908f8a57a0', sku: 'FRN-LIQ-DOT4-004', name: 'Líquido de frenos DOT 4 500 ml', stockAvailable: 60 },
  // Filtros
  { id: 'a61232d5-01a5-40f3-a6df-43afd1193165', sku: 'FIL-ACE-005', name: 'Filtro de aceite roscado', stockAvailable: 120 },
  { id: '1d31cc16-7b8f-4ff5-ba4d-3dbd16711a22', sku: 'FIL-AIR-006', name: 'Filtro de aire de motor panel', stockAvailable: 75 },
  { id: '8971f258-66d9-47dd-bc6b-7fb8ea260071', sku: 'FIL-CAB-007', name: 'Filtro de cabina con carbón activado', stockAvailable: 50 },
  { id: 'e3165a27-49d8-4484-a9e1-1a79743d3e3a', sku: 'FIL-COM-008', name: 'Filtro de combustible en línea', stockAvailable: 30 },
  // Motor y encendido
  { id: 'd6e1fd98-cb07-458f-aa12-6fe220b37604', sku: 'MOT-BUJ-IRI-009', name: 'Bujía de iridio', stockAvailable: 200 },
  { id: 'fe1bda15-7716-489c-8eaa-06fb9d38d5f0', sku: 'MOT-COR-DIS-010', name: 'Kit correa de distribución con tensor', stockAvailable: 12 },
  { id: 'e098c2cd-00d1-4f8c-b0ab-0e1a494fd888', sku: 'MOT-BOM-AGU-011', name: 'Bomba de agua', stockAvailable: 9 },
  { id: '2082914e-de18-4967-91cd-d044d1549645', sku: 'MOT-TER-012', name: 'Termostato con carcasa', stockAvailable: 22 },
  { id: 'cb5669e9-bc41-430b-8b30-f1561c39d5eb', sku: 'MOT-ACE-5W30-013', name: 'Aceite sintético 5W-30 4 L', stockAvailable: 90 },
  // Suspensión y dirección
  { id: 'bbd029e8-fbe4-4b4d-9508-8a49731123c1', sku: 'SUS-AMO-DEL-014', name: 'Amortiguador delantero a gas', stockAvailable: 16 },
  { id: '9b466627-0ee3-4a12-b481-600a85dc8c38', sku: 'SUS-BAN-015', name: 'Bandeja de suspensión inferior', stockAvailable: 8 },
  { id: '2b3c5c53-efeb-4816-90ab-eebc8849560f', sku: 'DIR-TER-016', name: 'Terminal de dirección', stockAvailable: 25 },
  // Eléctrico
  { id: '0d2f9987-0e9d-4eb1-8321-cd03cc03dae8', sku: 'ELE-BAT-60AH-017', name: 'Batería 12 V 60 Ah', stockAvailable: 3 },
  { id: '5bb2c044-90eb-4e4c-83ec-2815f25d3b0b', sku: 'ELE-ALT-018', name: 'Alternador 90 A reacondicionado', stockAvailable: 1 },
  { id: '27fdc79c-fa20-49cf-b3ac-1fd74ec776bc', sku: 'ELE-AMP-H4-019', name: 'Ampolleta halógena H4 60/55 W', stockAvailable: 150 },
  // Sin stock: permite demostrar el rechazo por stock insuficiente.
  { id: '74199389-6b4e-43f2-96b2-c2a4ab3959bc', sku: 'EMB-KIT-020', name: 'Kit de embrague completo', stockAvailable: 0 },
  { id: 'f989e963-a0fb-4799-80e8-1aeff10629be', sku: 'ESC-SIL-021', name: 'Silenciador de escape trasero', stockAvailable: 0 },
  // Pruebas de sistema RS-401.
  { id: SYSTEM_TEST_PART_ID, sku: 'SYS-TEST-000', name: 'Repuesto para pruebas de sistema RS-401', stockAvailable: SYSTEM_TEST_PART_STOCK },
  // Experimento RS-402.
  { id: EXPERIMENT_PART_ID, sku: 'EXP-TIMEOUT-000', name: 'Repuesto de carga para experimento RS-402', stockAvailable: 50000 },
];
