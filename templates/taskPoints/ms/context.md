Isi setiap baris selepas titik bertindih dan padamkan baris yang tidak berkenaan. AI menganggap baris kosong sebagai tidak diketahui dan menyerahkan sembang kepada pasukan anda.

Projek yang sedang berjalan:
Cara staf menulis ID tugasan (contoh):
Siapa yang menyemak kerja sebelum komisen dibayar:
Bila komisen dibayar:
Siapa yang dihubungi tentang mata atau komisen:
Bahasa lalai untuk balasan:

PERSEDIAAN HELAIAN (untuk pemilik; anda boleh memadamkan bahagian ini apabila helaian sudah siap)
Cipta satu Google Sheet dengan tab berikut. Baris 1 setiap tab mengandungi nama lajur. Dalam tetapan Google Sheets di EzyChat, tetapkan akses setiap tab untuk ejen ini seperti di bawah, kemudian klik Refresh.

1. Tasks (Read). Anda yang mengisi: Project | Task ID | Task | Points | KPI
   Satu baris bagi setiap tugasan. Points ialah nombor. Sasaran projek (contohnya 50,000 mata) ialah jumlah mata tugasannya. Gunakan ID tugasan tanpa ruang, contohnya ALPHA017.

2. Completions (Add rows). AI menambah satu baris bagi setiap tugasan yang dilaporkan: Date | Name | WhatsApp | Group | Project | Task ID | Note
   Jangan letak formula atau apa-apa lagi dalam tab ini: baris baharu ditambah di bawah baris terakhir, dan formula akan menolaknya ke bawah. AI tidak pernah mengubah baris; anda boleh membetulkan atau memadam baris sendiri.

3. Done (Read). Baris 1: Project | Task ID | Task | Points | Done by | WhatsApp | Date
   Dalam A2 tampal formula ini. Ia hanya menyenaraikan laporan PERTAMA bagi setiap projek dan ID tugasan yang ada dalam Tasks, jadi laporan berulang tidak pernah menambah mata:
   =ARRAYFORMULA(LET(p,Completions!E2:E,t,Completions!F2:F,k,UPPER(REGEXREPLACE(p&"|"&t,"[\s_-]","")),tk,UPPER(REGEXREPLACE(Tasks!A2:A&"|"&Tasks!B2:B,"[\s_-]","")),first,MATCH(k,k,0)=SEQUENCE(ROWS(k)),known,ISNUMBER(MATCH(k,tk,0)),IFERROR(FILTER(HSTACK(IFERROR(VLOOKUP(k,HSTACK(tk,Tasks!A2:D),{2,3,4,5},FALSE),""),Completions!B2:B,Completions!C2:C,Completions!A2:A),(p<>"")*(t<>"")*first*known),"")))

4. Progress (Read, atau Off jika staf tidak patut melihatnya). Baris 1: Project | Total points | Points done | Progress
   A2: =UNIQUE(FILTER(Tasks!A2:A,Tasks!A2:A<>""))
   B2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Tasks!A2:A,x,Tasks!D2:D))))
   C2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Done!A2:A,x,Done!D2:D))))
   D2: =MAP(B2:B,C2:C,LAMBDA(total,done,IF(total="","",IF(total=0,0,done/total))))
   Format lajur D sebagai peratus (0 hingga 100 %).

5. Staff (Off). Anda yang mengisi: WhatsApp | Staff name | RM per point
   WhatsApp dengan kod negara, contohnya +60123456789.

6. Commission (Off). Baris 1: WhatsApp | Staff name | RM per point | Points | Commission (RM)
   A2: =FILTER(Staff!A2:C,Staff!A2:A<>"")
   D2: =MAP(A2:A,LAMBDA(w,IF(w="","",IFERROR(SUM(FILTER(Done!D2:D,ARRAYFORMULA(REGEXREPLACE(TO_TEXT(Done!F2:F),"\D",""))=REGEXREPLACE(TO_TEXT(w),"\D",""))),0))))
   E2: =MAP(C2:C,D2:D,LAMBDA(rate,pts,IF(pts="","",rate*pts)))
   Ubah E2 jika peraturan komisen anda bukan kadar tetap bagi setiap mata.

Mata dan komisen hanya mengira baris dalam Done, jadi tugasan yang dilaporkan dua kali dibayar sekali sahaja. Laporan yang sel WhatsAppnya kosong tidak dikira dalam Commission sehingga anda mengisi nombornya.
