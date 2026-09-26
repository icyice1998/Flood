"""Roads and landmarks that Thai/English flood news mentions instead of district
names, mapped to the districts they run through. Approximate by nature: a news
item tagged this way stays "reported, unverified" evidence.
"""
import re

# (regex, [district names as in data/districts.geojson])
ROADS = [
    (r"วิภาวดี|Vibhavadi", ["ดินแดง", "จตุจักร", "หลักสี่", "ดอนเมือง"]),
    (r"รัชดา|Ratchada", ["ห้วยขวาง", "ดินแดง", "จตุจักร"]),
    (r"พหลโยธิน|พหลฯ|Phahon ?Yothin|Phaholyothin", ["พญาไท", "จตุจักร", "บางเขน", "หลักสี่", "ดอนเมือง", "สายไหม"]),
    (r"สุขุมวิท|Sukhumvit", ["วัฒนา", "คลองเตย", "พระโขนง", "บางนา"]),
    (r"รามคำแหง|Ramkhamhaeng", ["บางกะปิ", "สะพานสูง", "มีนบุรี"]),
    (r"ศรีนครินทร์|Srinakarin", ["สวนหลวง", "ประเวศ", "บางนา"]),
    (r"งามวงศ์วาน|Ngamwongwan", ["เมืองนนทบุรี", "จตุจักร", "หลักสี่"]),
    (r"แจ้งวัฒนะ|Chaeng ?Watthana", ["ปากเกร็ด", "หลักสี่"]),
    (r"เพชรเกษม|Phetkasem", ["ภาษีเจริญ", "บางแค", "หนองแขม"]),
    (r"พระราม ?2|Rama (?:2|II)\b", ["จอมทอง", "บางขุนเทียน"]),
    (r"พระราม ?4|Rama (?:4|IV)\b", ["ปทุมวัน", "คลองเตย", "บางรัก"]),
    (r"พระราม ?9|Rama (?:9|IX)\b", ["ห้วยขวาง"]),
    (r"นวมินทร์|Nawamin", ["บึงกุ่ม", "คันนายาว", "บางกะปิ"]),
    (r"รามอินทรา|Ram ?Inthra", ["บางเขน", "คันนายาว", "คลองสามวา", "มีนบุรี"]),
    (r"สุวินทวงศ์|Suwinthawong", ["มีนบุรี", "หนองจอก"]),
    (r"อ่อนนุช|On ?Nut", ["สวนหลวง", "ประเวศ", "พระโขนง"]),
    (r"บางนา-?ตราด|Bang ?Na-?Trat", ["บางนา", "บางพลี"]),
    (r"ประชาชื่น|Pracha ?Chuen", ["บางซื่อ", "จตุจักร"]),
    (r"ปิ่นเกล้า|Pinklao", ["บางกอกน้อย", "บางพลัด"]),
    (r"จรัญสนิทวงศ์|จรัญฯ|Charan ?Sanitwong", ["บางกอกน้อย", "บางพลัด", "บางกอกใหญ่"]),
    (r"ราชพฤกษ์|Ratchaphruek", ["ตลิ่งชัน", "ภาษีเจริญ"]),
    (r"บรมราชชนนี|Borommaratchachonnani", ["ตลิ่งชัน", "ทวีวัฒนา"]),
    (r"สีลม|Silom", ["บางรัก"]),
    (r"อโศก|Asok", ["วัฒนา", "คลองเตย"]),
    (r"ทองหล่อ|Thong ?Lo", ["วัฒนา"]),
    (r"เอกมัย|Ekkamai", ["วัฒนา"]),
    (r"อนุสาวรีย์ชัย|Victory Monument", ["ราชเทวี"]),
    (r"ประตูน้ำ|Pratunam", ["ราชเทวี"]),
    (r"สยาม|Siam", ["ปทุมวัน"]),
    (r"สุวรรณภูมิ|Suvarnabhumi", ["บางพลี"]),
    (r"หลักหก|Lak ?Hok", ["เมืองปทุมธานี"]),
    (r"(?<!วิภาวดี)(?<!วิภาวดี-)รังสิต|(?<!Vibhavadi )(?<!Vibhavadi-)Rangsit", ["ธัญบุรี"]),
    (r"มหาชัย|Mahachai", ["เมืองสมุทรสาคร"]),
    (r"สำโรง|Samrong", ["เมืองสมุทรปราการ", "พระประแดง"]),
]
ROADS = [(re.compile(rx, re.I), ds) for rx, ds in ROADS]


def districts_from_places(text):
    """Return {district_name: matched_place}."""
    hits = {}
    for rx, ds in ROADS:
        m = rx.search(text)
        if m:
            for d in ds:
                hits.setdefault(d, m.group(0))
    return hits
