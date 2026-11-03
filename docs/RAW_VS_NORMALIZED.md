# Raw WhatsApp messages vs Extract v2 normalized rows

Generated: 2026-10-08T13:25:02.194Z

## Snapshot

| Metric | Count |
|--------|------:|
| Raw messages (with text) | 3278 |
| Normalized messages (unique) | 2518 |
| Normalized rows (incl. multi-listing) | 3878 |
| Property rows | 3294 |
| Still pending | 760 |

Provider: `openai` / `gpt-4o-mini` → deterministic parsers + location canon + `place_tags`.

## How to read each example

- **RAW** = full WhatsApp body stored in `whatsapp_messages.message`
- **NORMALIZED** = one or more rows in `normalized_messages` for that message (`listing_index` 0, 1, …)
- `area` / `society_key` / `phase` / `place_tags` feed search (e.g. Ittehad → DHA + phase-2 + phase-6 tags)

---

## Example 1: message `11134` (user 4) — 1 listing row(s)

### RAW

```
🏠 Brand New 120 Yards House for Sale – Phase 7 Extension
🔹 Double Storey
🔹 2 + 2 Planning 
🔹 Basement with 1 Room (Without Washroom)
🔹 Drawing Room
🔹 Attached Bathrooms
🔹 Demand: PKR 9.50 Crore
🏢 Empire Estate
👤 Zeeshan
📞 03182427563
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | HOUSE |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 7 |
| vicinity | Phase 7 Extension |
| size (raw text) | 120 Yards |
| size (parsed) | 120 Sq. Yd. (1080 sqft) |
| price (raw text) | Demand: PKR 9.50 Crore |
| price_value | 95000000 |
| price_basis | TOTAL |
| price_inferred | false |
| contact_number | 03182427563 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 7 extension, phase-7, phase 7, phase vii, ph 7, dha phase 7, karachi |
| listing_excerpt | 🏠 Brand New 120 Yards House for Sale – Phase 7 Extension 🔹 Double Storey 🔹 2 + 2 Planning  🔹 Basement with 1 Room (Without Washroom) 🔹 Drawing Room 🔹 Attached Bathrooms 🔹 Demand: PKR 9.50 Crore |

---

## Example 2: message `11133` (user 4) — 1 listing row(s)

### RAW

```
•	Apartment for sale, Rahat Commercial, 2 Bed D/D,3rd floor, Front entrance, with lift, Demand 2cr (Haider) 03246991624
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | APARTMENT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Rahat Commercial |
| vicinity | Phase 6, Rahat Commercial |
| price (raw text) | Demand 2cr |
| price_value | 20000000 |
| price_basis | TOTAL |
| price_inferred | false |
| contact_number | 03246991624 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 rahat commercial, phase 6, phase-6, phase vi, ph 6, dha phase 6, rahat, phase-7, phase 7, phase vii, ph 7, dha phase 7, rahat commercial, karachi |
| listing_excerpt | • Apartment for sale, Rahat Commercial, 2 Bed D/D,3rd floor, Front entrance, with lift, Demand 2cr |

---

## Example 3: message `11131` (user 4) — 2 listing row(s)

### RAW

```
*DHA Residents plots*

• *Sahil 300 yards west open @ 6.60*
• *Phase 6 street 15 1000 &  2000 yards plot*
*DHA Phase 8 666 yards 1st belt Zone A on st 25 of Qasim Park face plot* 
*Main Khybar corner 2000 yards demand 50 crore*
*Phase 8 E zone west open street 31 1000 yards demand 25 crore*
• *Phase 8 Main Qasim 2000+2000 single & pair plots available*
• *Kh E Galib 2000 yards available demand 55*
• *Main Tipu 2000 yards plot @ 45*
• *Defence street 4 plot west open*

*ESTATE BNK*
*Al Murtaza Comm DHA Phase 8 Karachi*
👤 *Chaudhry Sohail Akbar*
📱 *0321 8991421*
```

### NORMALIZED

#### Listing index 1

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Street 15 |
| vicinity | Phase 6, Street 15 |
| size (raw text) | 1000 & 2000 yards |
| size (parsed) | 1000 Sq. Yd. (9000 sqft) |
| price_inferred | false |
| contact_number | 0321 8991421 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 street 15, phase 6, phase-6, phase vi, ph 6, dha phase 6, karachi, street 15 |
| listing_excerpt | • Phase 6 street 15 1000 & 2000 yards plot |

#### Listing index 8

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Defence Street |
| vicinity | Phase 8, Defence Street |
| price_inferred | false |
| contact_number | 0321 8991421 |
| needs_review | true |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 defence street, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, defence street, karachi, defence street 4 |
| listing_excerpt | • Defence street 4 plot west open |

---

## Example 4: message `11126` (user 4) — 1 listing row(s)

### RAW

```
Dha city Very very chance deal plot no 306 sector 12f 125 yard next to corner 24lac  time one month
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA City |
| society_key | dha-city |
| location_text | Sector 12f |
| vicinity | Sector 12f |
| size (raw text) | 125 yard |
| size (parsed) | 125 Sq. Yd. (1125 sqft) |
| price (raw text) | 24lac |
| price_value | 2400000 |
| price_basis | TOTAL |
| price_inferred | false |
| contact_number | 03212031282 |
| needs_review | false |
| place_tags (sample) | dha city, sector 12f, karachi |
| listing_excerpt | Dha city Very very chance deal plot no 306 sector 12f 125 yard next to corner 24lac time one month |

---

## Example 5: message `11121` (user 4) — 1 listing row(s)

### RAW

```
•	Apartment for sale 20c 900sqft rahat comm. 2bed D/D with lift brand new 2nd floor Demand 230 ,03246991624, Haider
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | APARTMENT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Rahat |
| vicinity | Phase 6, Rahat |
| size (raw text) | 900sqft |
| size (parsed) | 900 Sq. Ft. (900 sqft) |
| price (raw text) | Demand 230 |
| price_value | 23000000 |
| price_basis | TOTAL |
| price_inferred | true |
| contact_number | 03246991624 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 rahat, phase 6, phase-6, phase vi, ph 6, dha phase 6, rahat, phase-7, phase 7, phase vii, ph 7, dha phase 7, karachi, rahat comm |
| listing_excerpt | • Apartment for sale 20c 900sqft rahat comm. 2bed D/D with lift brand new 2nd floor Demand 230 |

---

## Example 6: message `11108` (user 4) — 1 listing row(s)

### RAW

```
*Studio for rent*
Small Bukhari
1st floor
Furnish
Tile flooring
Demand 85
*Ejaz 03219295998*
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | RENT |
| property_type | OTHER |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Bukhari |
| vicinity | Phase 6, Bukhari |
| price (raw text) | Demand 85 |
| price_value | 8500000 |
| price_basis | TOTAL |
| price_inferred | true |
| contact_number | 03219295998 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 bukhari, phase 6, phase-6, phase vi, ph 6, dha phase 6, bukhari, karachi, small bukhari |
| listing_excerpt | Studio for rent Small Bukhari 1st floor Furnish Tile flooring Demand 85 |

---

## Example 7: message `11070` (user 4) — 1 listing row(s)

### RAW

```
666 Yards Bungalow for sale
2+5 bedrooms
Basement
Khy Ittehad
Well Maintained 
12 Year Old 

Demand 18.75

Contact:
ALPHA PROPERTIES 
HUNAIN VAYANI 
03233206572
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | BUNGALOW |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Khayaban-e-Ittehad |
| vicinity | Phase 6, Khayaban-e-Ittehad |
| size (raw text) | 666 Yards |
| size (parsed) | 666 Sq. Yd. (5994 sqft) |
| price (raw text) | Demand 18.75 |
| price_value | 1875000 |
| price_basis | TOTAL |
| price_inferred | true |
| contact_number | 03233206572 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 khayaban-e-ittehad, phase 6, phase-6, phase vi, ph 6, dha phase 6, khayaban-e-ittehad, phase-2, phase 2, phase ii, ph 2, dha phase 2, phase-7, phase 7, phase vii |
| listing_excerpt | 666 Yards Bungalow for sale 2+5 bedrooms Basement Khy Ittehad Well Maintained  12 Year Old  Demand 18.75 |

---

## Example 8: message `10745` (user 4) — 19 listing row(s)

### RAW

```
♦️
*D.H.A COMM. PLOTS FOR SALE*
♦️  

♦️♦️
*Commercial Plots* 
♦️Beach Avenue Jori 
300+300 Sqy 

Beach Street 
Garner Number (300-300)

♦️ Iqbal lane-3+Peninsula-18 (100+100) 

♦️ Peninsula-2+Tipu-2 Corner (100)

♦️Tipu-2 (100+100)

♦️ Peninsula-3+11 Commercial Corner (100) 

♦️Sahil Comm. Street-3 Next to Sea Facing (100)

♦️ Peninsula-15 (200)

♦️Sahil Street-1, Next to Sea 
(100+100)

♦️ Peninsula 
Tipu-2A (100) 

♦️ Peninsula Lane-1 (200+200)

♦️Sahil Street-6+Abu Bakar (100+100)

♦️Main Tipu (100)

♦️ Peninsula lane-11 (200) 

Shabaz Commercial lane-4 (200) 

♦️Murtaza Commercial Lane-4 

♦️♦️
*C.B.D COMMERCIAL* 

♦️Main Boulevard (300) 

♦️(200+200) 
Jori 

♦️(200) 

*REAL PROPERTY PRIME TIME* 

MUHAMMAD ASLAM 
03332997975 
03072997975
```

### NORMALIZED

#### Listing index 0

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| location_text | Beach Avenue |
| vicinity | Beach Avenue |
| size (raw text) | 300+300 Sqy |
| size (parsed) | 300 Sq. Yd. (2700 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | true |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, beach avenue, phase-4, phase 4, phase iv, ph 4, dha phase 4, phase-6, phase 6, phase vi, ph 6, dha phase 6, phase-8, phase 8, phase viii, ph 8 |
| listing_excerpt | Beach Avenue Jori 300+300 Sqy |

#### Listing index 1

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| location_text | Beach Street |
| vicinity | Beach Street |
| size (raw text) | 300-300 |
| size (parsed) | 300 Sq. Yd. (2700 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, beach street, karachi, d h a |
| listing_excerpt | Beach Street Garner Number (300-300) |

#### Listing index 2

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 100+100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, iqbal lane-3+peninsula-18, iqbal, phase-1, phase 1, phase i, ph 1 |
| listing_excerpt | Iqbal lane-3+Peninsula-18 (100+100) |

#### Listing index 3

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula-2+tipu-2, d h a |
| listing_excerpt | Peninsula-2+Tipu-2 Corner (100) |

#### Listing index 4

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| location_text | Tipu 2 |
| vicinity | Tipu 2 |
| size (raw text) | 100+100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, tipu 2, karachi, tipu-2, d h a |
| listing_excerpt | Tipu-2 (100+100) |

#### Listing index 5

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula-3+11, d h a |
| listing_excerpt | Peninsula-3+11 Commercial Corner (100) |

#### Listing index 6

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Sahil |
| vicinity | Phase 8, Sahil |
| size (raw text) | 100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 sahil, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, sahil, karachi, sahil comm street-3, d h a |
| listing_excerpt | Sahil Comm. Street-3 Next to Sea Facing (100) |

#### Listing index 7

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula-15, d h a |
| listing_excerpt | Peninsula-15 (200) |

#### Listing index 8

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Sahil Street |
| vicinity | Phase 8, Sahil Street |
| size (raw text) | 100+100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 sahil street, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, sahil, sahil street, karachi, sahil street-1, d h a |
| listing_excerpt | Sahil Street-1, Next to Sea (100+100) |

#### Listing index 9

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula tipu-2a, d h a |
| listing_excerpt | Peninsula Tipu-2A (100) |

#### Listing index 10

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 200+200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula lane-1, d h a |
| listing_excerpt | Peninsula Lane-1 (200+200) |

#### Listing index 11

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Sahil Street |
| vicinity | Phase 8, Sahil Street |
| size (raw text) | 100+100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 sahil street, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, sahil, sahil street, karachi, sahil street-6+abu bakar, abu bakar, phase-5, phase 5, phase v |
| listing_excerpt | Sahil Street-6+Abu Bakar (100+100) |

#### Listing index 12

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| location_text | Main Tipu |
| vicinity | Main Tipu |
| size (raw text) | 100 |
| size (parsed) | 100 Sq. Yd. (900 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, main tipu, karachi, d h a |
| listing_excerpt | Main Tipu (100) |

#### Listing index 13

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 8 |
| location_text | Peninsula |
| vicinity | Phase 8, Peninsula |
| size (raw text) | 200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 8 peninsula, phase 8, phase-8, phase viii, ph 8, dha phase 8, pha 8, peninsula, karachi, peninsula lane-11, d h a |
| listing_excerpt | Peninsula lane-11 (200) |

#### Listing index 14

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| phase | 6 |
| location_text | Shahbaz Commercial Lane 4 |
| vicinity | Phase 6, Shahbaz Commercial Lane 4 |
| size (raw text) | 200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, phase 6 shahbaz commercial lane 4, phase 6, phase-6, phase vi, ph 6, dha phase 6, shahbaz, phase-1, phase 1, phase i, ph 1, dha phase 1, phase-2, phase 2, phase ii |
| listing_excerpt | Shabaz Commercial lane-4 (200) |

#### Listing index 15

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | DHA |
| society_key | dha |
| location_text | Murtaza Commercial Lane 4 |
| vicinity | Murtaza Commercial Lane 4 |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | dha, dha karachi, defence, defense, dha defence, murtaza commercial lane 4, karachi, murtaza commercial lane-4, d h a |
| listing_excerpt | Murtaza Commercial Lane-4 |

#### Listing index 16

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | C.B.D |
| society_key | c-b-d |
| location_text | Main Boulevard |
| vicinity | Main Boulevard |
| size (raw text) | 300 |
| size (parsed) | 300 Sq. Yd. (2700 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | c b d, main boulevard, karachi |
| listing_excerpt | Main Boulevard (300) |

#### Listing index 17

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | C.B.D |
| society_key | c-b-d |
| location_text | Jori |
| vicinity | Jori |
| size (raw text) | 200+200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | c b d, jori, karachi |
| listing_excerpt | (200+200) Jori |

#### Listing index 18

| Field | Value |
|-------|-------|
| listing_kind | OFFER |
| purpose | SALE |
| property_type | PLOT |
| city | Karachi |
| area | C.B.D |
| society_key | c-b-d |
| size (raw text) | 200 |
| size (parsed) | 200 Sq. Yd. (1800 sqft) |
| price_inferred | false |
| contact_number | 03332997975, 03072997975 |
| needs_review | false |
| place_tags (sample) | c b d, karachi |
| listing_excerpt | (200) |

---

## Key columns used by search

| Column | Role |
|--------|------|
| `area` / `society_key` | Society (e.g. DHA, DHA City) |
| `phase` | Preferred DHA phase number |
| `location_text` / `street_text` / `vicinity` | Specific place + display string |
| `place_tags` | Expand search (locality + parent phases) |
| `price_value` / `size_sqft` | Numeric filters |
| `listing_excerpt` | Snippet of this offer from the raw message |
