"""Headline filter for Floodwatcher.

Keeps only reports of rising water, active flooding, heavy rain or official
warnings. Drops opinion/emotional pieces and news about water receding or
relief handouts. Rule-based and transparent: every decision returns a reason.

    python3 news_filter.py   # runs the built-in examples
"""
import re

# Reports that water is rising or overflowing
RISING = re.compile(
    r"ระดับน้ำ(?:\S{0,6})?(?:เพิ่ม|สูงขึ้น|ขึ้น|พุ่ง|ล้น|วิกฤต)|น้ำ(?:เพิ่มสูง|ขึ้นสูง|ทะลัก|ล้นตลิ่ง|เอ่อ)|เอ่อล้น|ล้นตลิ่ง|"
    r"ทะเลหนุน|น้ำหนุน|น้ำขึ้นสูง|เขื่อน\S{0,20}(?:ระบาย|ปล่อยน้ำ)\S{0,6}เพิ่ม|ระบายน้ำเพิ่ม|คันกั้นน้ำ\S{0,6}(?:แตก|พัง|รั่ว)|"
    r"water levels? (?:rise|rises|rising|rose|up|climb)|overflow|burst (?:its )?banks?|high tide|dam release|swollen",
    re.I)
# Reports of flooding happening now
FLOODING = re.compile(
    r"น้ำท่วม|ท่วมขัง|ท่วมสูง|ท่วมหนัก|ท่วมถนน|ท่วมบ้าน|ท่วมทั้งซอย|ท่วมหลายจุด|น้ำรอระบาย|จมน้ำ|จมบาดาล|"
    r"รถเล็ก\S{0,8}(?:ห้าม|งด|ไม่ควร)|ปิดถนน|ปิดการจราจร|เดินทางไม่ได้|"
    r"flood(?:s|ed|ing)?\b|inundat|submerg|waterlog|under water",
    re.I)
WARNING = re.compile(
    r"เตือนภัย|ประกาศเตือน|แจ้งเตือน|เฝ้าระวัง|อพยพ|ประกาศภัยพิบัติ|พื้นที่ประสบภัย|เขตภัยพิบัติ|สั่งปิด|เร่งระบาย|ระบายไม่ทัน|"
    r"warning|alert|evacuat|disaster (?:zone|area)|declare[sd]? (?:a )?disaster|state of emergency",
    re.I)
RAIN = re.compile(r"ฝนตกหนัก|ฝนหนัก|ฝนถล่ม|ฝนกระหน่ำ|ฝนสะสม|พายุ|heavy rain|torrential|downpour|storm|cloudburst", re.I)

# Opinion, emotion, blame, lifestyle and unrelated angles
OPINION = re.compile(
    r"ดราม่า|ชาวเน็ต|โซเชียล(?:เดือด|แห่|สนั่น|ถกสนั่น)|เดือด(?!ร้อน)|ฟาด|จวก|ซัด(?!ฝั่ง)|ด่า(?!น)|วิจารณ์|ความเห็น|มุมมอง|บทความ|คอลัมน์|บทบรรณาธิการ|"
    r"ทัศนะ|ตั้งคำถาม|ถามหา|ทำไม|อย่างไร|ไม่พอใจ|สุดทน|โวย|บ่น|ประชด|แซะ|เสียดสี|มีม|ขำ|ตลก|สะเทือนใจ|น้ำตา|ใจสลาย|"
    r"เศร้า|สงสาร|ซึ้ง|ดวง|หวย|เลขเด็ด|ย้อนรอย|ย้อนดู|ครบรอบ|วิธีรับมือ|เคล็ดลับ|ทริค|ประกันภัย|โปรโมชั่น|ส่วนลด|ดารา|คนดัง|"
    r"ฝ่ายค้าน|หาเสียง|โทษ|ความผิดใคร|โพสต์(?:ระบาย|เล่า|อ้อน|ขอบคุณ|ถึง)|ระบายความ|วิถีชีวิต|ชีวิตคน|เร่งซื้อ|ตุน|ใจหาย|ช็อก|อึ้ง|หดหู่|สลด|ใครทันใครได้|โคม่า|"
    r"\bopinion\b|editorial|commentary|\bcolumn\b|analysis|explainer|\bwhy\b|how to|what to know|lessons? from|\bblame|slams?\b|"
    r"criticis|outrage|netizens|\bviral\b|\bmeme|horoscope|lottery|\btips?\b|insurance|\bdeals?\b|podcast|\bquiz\b",
    re.I)
# Meetings, visits and statements by officials: about the response, not the water
OFFICIAL_ACTIVITY = re.compile(
    r"ประชุม|ถกด่วน|สั่งการ|ลงพื้นที่|ตรวจเยี่ยม|ติดตามสถานการณ์|นายกฯ|นายกรัฐมนตรี|รัฐมนตรี|อนุทิน|ผู้ว่าฯ\S{0,10}(?:ลงพื้นที่|ตรวจ)|"
    r"\bPM\b|prime minister|minister|governor (?:visits|inspects)|meeting",
    re.I)
# Water going down, clean-up, compensation, donations
RECEDING = re.compile(
    r"ลดลง|คลี่คลาย|น้ำแห้ง|แห้งแล้ว|กลับสู่ภาวะปกติ|กลับมาสัญจร|สัญจรได้|ระบายหมดแล้ว|ฟื้นฟู|เยียวยา|ชดเชย|ล้างทำความสะอาด|"
    r"บริจาค|มอบถุงยังชีพ|ถุงยังชีพ|ระดม\S{0,10}ช่วย|ลุยช่วย|ส่งกำลัง|"
    r"recede|receding|subsid|clean-?up|reopen|back to normal|donat|relief fund|compensation|aftermath",
    re.I)


def strip_source(title):
    """Google News appends ' - Publisher'; drop it before matching."""
    return re.sub(r"\s+[-–|]\s+[^-–|]{2,60}$", "", title).strip()


def classify(title):
    """Return (keep, categories, reason)."""
    t = strip_source(title)
    if "?" in t or "!!" in t:
        return False, [], "question/exclamation"
    if OPINION.search(t):
        return False, [], "opinion/emotion"
    cats = [name for name, rx in (("rising", RISING), ("flooding", FLOODING), ("warning", WARNING), ("rain", RAIN))
            if rx.search(t)]
    if OFFICIAL_ACTIVITY.search(t) and "rising" not in cats:
        return False, [], "official activity/politics"
    if RECEDING.search(t) and not ({"rising", "warning"} & set(cats)):
        return False, [], "receding/relief"
    if not cats:
        return False, [], "not about rising water/flooding"
    # Rain alone is weather, not impact: keep only with flooding/rising/warning
    if cats == ["rain"]:
        return False, [], "rain only, no impact"
    return True, cats, "ok"


EXAMPLES = [
    ("กทม.แจ้งเตือนพื้นที่น้ำท่วมขัง-รถเล็กห้ามผ่าน - Thai PBS", True),
    ("ระดับน้ำคลองลาดพร้าวเพิ่มสูงขึ้น เอ่อล้นเข้าชุมชน - ไทยรัฐ", True),
    ("Bangkok declares disaster zone as torrential rain floods city - Reuters", True),
    ("Chao Phraya water levels rising as dam release increases - Bangkok Post", True),
    ("ชาวเน็ตเดือด! ถามหาผู้ว่าฯ น้ำท่วมทีไรเป็นแบบนี้ - Sanook", False),
    ("ทำไมกรุงเทพน้ำท่วมทุกปี? - The Standard", False),
    ("Opinion: Bangkok's floods are a failure of planning - Nikkei", False),
    ("น้ำท่วมสุขุมวิทลดลงแล้ว รถสัญจรได้ตามปกติ - Matichon", False),
    ("มอบถุงยังชีพผู้ประสบภัยน้ำท่วม - NBT", False),
    ("พยากรณ์อากาศวันนี้ ฝนตกหนักบางแห่ง - TNN", False),
    ("5 tips to protect your car from floods - Carousell", False),
    ("“อนุทิน” สั่งการข้ามทวีป! ถกด่วนน้ำท่วม กทม.–5 จังหวัด - ข่าวหุ้น", False),
    ("วิถีชีวิตช่วงน้ำท่วม คนกรุงเร่งซื้ออาหาร น้ำดื่ม - ททบ. 5", False),
    ("ดาราโพสต์ระบายน้ำท่วมตัดขาด ทีมงานมาไม่ได้ - Sanook", False),
    ("กทม. สั่งปิดโรงเรียน 437 แห่ง หลังฝนหนัก-น้ำท่วมขัง - ททบ. 5", True),
    ("SRT cancels Eastern Line trains amid floods - Nation Thailand", True),
    ("รัฐบาลระดมทหาร 1 หมื่นนาย ลุยช่วยน้ำท่วม - ททบ. 5", False),
    ("เห็นแล้วใจหาย! แฟลตคลองจั่นน้ำสูงถึงอก รถจมแทบมิด - Amarin", False),
    ("ใครทันใครได้! น้ำท่วมกรุงเทพ รัชดาฯ โคม่า ตุนอาหาร 7-11 เกลี้ยง - Sanook", False),
    ("เปิด 20 จุดน้ำท่วมกรุง รามคำแหง 43/1 สูงสุด 17.5 ซม. หลังฝนถล่มข้ามคืน - Thairath", True),
]

if __name__ == "__main__":
    bad = 0
    for title, want in EXAMPLES:
        keep, cats, reason = classify(title)
        mark = "ok " if keep == want else "BAD"
        bad += keep != want
        print(f"{mark} keep={keep!s:5} {','.join(cats):24} {reason:32} {title}")
    raise SystemExit(bad)
