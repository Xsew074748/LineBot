# IT Monitor LINE Bot

## วิธีทำงานที่ต้องการ
- ตอบเป็นภาษาไทยเสมอ ยกเว้นชื่อไฟล์ คำสั่ง และโค้ด
- ห้ามตอบเป็นภาษาญี่ปุ่น เกาหลี หรือจีน

## บทเรียนที่เจอมาแล้ว (อย่าพลาดซ้ำ)
- Deploy image ใหม่ให้ bot ที่มีอยู่แล้วผ่าน Manager: "อัปเดต Image" (pull)
  อย่างเดียวไม่พอ ต้อง remove+recreate container ด้วย ไม่งั้น container
  เดิมจะยังรัน image เก่าอยู่ (ดูรายละเอียดใน NetguardManager/CLAUDE.md)
