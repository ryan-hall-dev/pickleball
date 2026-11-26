import type { Messages } from "./en";
import { hostVi } from "./hostVi";
import { engineErrorsVi, serverMessagesVi } from "./serverVi";

// Vietnamese interface text, drafted by Claude: a native speaker reviews it
// before each deploy (docs/plans/bilingual-ui.md). Players are addressed as
// "bạn".

export const vi: Messages = {
  languageSwitch: {
    label: "Ngôn ngữ",
  },
  themeSwitch: {
    darkMode: "Chế độ tối",
  },
  loading: {
    checkin: "Đang tải trang điểm danh…",
  },
  appName: "Pickleball Social Manager",
  levels: {
    beginner: "Mới chơi",
    intermediate: "Trung bình",
    advanced: "Nâng cao",
  },
  genders: {
    male: "Nam",
    female: "Nữ",
  },
  validation: {
    firstNameRequired: "Nhập tên của bạn",
    lastNameRequired: "Nhập họ của bạn",
    levelRequired: "Chọn trình độ của bạn",
    genderRequired: "Chọn nam hoặc nữ.",
    nameTooLong: (maxLength: number) => `Tối đa ${maxLength} ký tự.`,
    nameHasControlCharacters: "Xóa các ký tự đặc biệt.",
    hostFirstNameRequired: "Nhập tên.",
    hostLastNameRequired: "Nhập họ.",
    hostLevelRequired: "Chọn trình độ.",
    sessionNameRequired: "Nhập tên buổi chơi.",
    wholeMinutes: (min: number, max: number) =>
      `Nhập số phút nguyên từ ${min} đến ${max}.`,
    courtCountRange: (min: number, max: number) =>
      `Nhập số sân nguyên từ ${min} đến ${max}.`,
    validEmail: "Nhập địa chỉ email hợp lệ.",
    displayNameRequired: "Nhập tên hiển thị.",
    socialNameRequired: "Nhập tên nhóm.",
    checkHighlightedFields: "Hãy kiểm tra các ô được đánh dấu.",
  },
  time: {
    minutesLeft: (minutes: number) => `Còn ${minutes} phút`,
    sessionMinutes: (minutes: number) => `Buổi chơi ${minutes} phút`,
    minutes: (minutes: number) => `${minutes} phút`,
    durationUnavailable: "Chưa có thời lượng",
    startTimeUnavailable: "Chưa có giờ bắt đầu",
    startedEndUnavailable: (startTime: string) =>
      `Bắt đầu lúc ${startTime} · chưa có giờ kết thúc`,
    sessionTimeIsUp: "Đã hết giờ chơi",
  },
  checkin: {
    pageTitle: "Điểm danh",
    welcomeHeading: (socialName: string) =>
      `Chào mừng bạn đến với ${socialName}`,
    welcomeIntro: "Vui lòng nhập thông tin để điểm danh.",
    formLabel: "Điểm danh",
    firstName: "Tên",
    lastName: "Họ",
    yourLevel: "Trình độ của bạn",
    gender: "Giới tính",
    checkIn: "Điểm danh",
    hostApprovesNote:
      "Người tổ chức sẽ duyệt từng lượt điểm danh trước khi bạn được thêm vào danh sách người chơi hôm nay.",
    sessionCard: {
      notStarted: "Chưa bắt đầu",
      liveNow: "Đang diễn ra",
      courts: "sân",
      checkedIn: "đã điểm danh",
      duration: "thời lượng",
      unavailable: "Chưa có",
    },
    pill: {
      waiting: "Đang chờ",
      checkedIn: "Đã điểm danh",
    },
    waiting: {
      title: "Đang chờ người tổ chức duyệt",
      sent: (sessionName: string) =>
        `Yêu cầu điểm danh của bạn cho ${sessionName} đã được gửi.`,
      updatesItself: "Trang này tự cập nhật sau vài giây.",
      whileYouWait: "Trong lúc chờ",
      keepOpen:
        "Hãy giữ trang này mở, hoặc quay lại đúng đường link này sau. Yêu cầu của bạn vẫn được giữ.",
      takingAWhile: "Chờ lâu quá? Hãy báo người tổ chức là bạn đã đến.",
    },
    approved: {
      title: (firstName: string) => `Bạn đã vào danh sách, ${firstName}`,
      checkedInTo: (sessionName: string) =>
        `Bạn đã điểm danh vào ${sessionName}.`,
      whatNext: "Tiếp theo",
      courtWhenTurn: "Người tổ chức sẽ xếp bạn vào sân khi đến lượt.",
      stayNear: "Hãy ở gần sân và chú ý khi được gọi tên.",
      canClose: "Bạn có thể đóng trang này.",
    },
    alreadyCheckedIn: {
      title: (sessionName: string) => `Bạn đã điểm danh vào ${sessionName}`,
      nothingMore: (firstName: string) =>
        `Bạn không cần làm gì thêm, ${firstName}. Hãy ở gần sân và chú ý khi được gọi tên.`,
    },
    rejected: {
      title: "Lượt điểm danh chưa được duyệt",
      text: "Người tổ chức chưa duyệt lượt điểm danh này. Vui lòng nói chuyện với người tổ chức.",
    },
    rateLimited: {
      title: "Quá nhiều lần thử",
      text: "Bạn đã thử quá nhiều lần. Vui lòng đợi vài phút rồi thử lại.",
    },
    inactive: {
      title: "Đường link điểm danh này không còn hoạt động",
      text: "Hãy hỏi người tổ chức ở sân để lấy mã QR mới.",
    },
    noOpenSession: {
      title: "Hiện chưa có buổi chơi nào mở",
      text: "Hãy quay lại khi người tổ chức mở buổi chơi.",
      checkAgain: "Kiểm tra lại",
    },
    unavailable: {
      title: "Đã xảy ra lỗi",
      text: "Không kết nối được với trang điểm danh. Hãy kiểm tra kết nối mạng và thử lại.",
      noDoubleSend:
        "Nếu bạn đã bấm Điểm danh, thử lại sẽ không gửi thêm yêu cầu thứ hai.",
    },
    roster: {
      findHeading: "Tìm tên của bạn",
      findIntro: "Gõ ít nhất 2 chữ cái của tên bạn dùng trên Reclub.",
      searchLabel: "Tên của bạn",
      typeMore: "Gõ ít nhất 2 chữ cái.",
      searching: "Đang tìm…",
      noMatches:
        "Không tìm thấy tên nào. Hãy kiểm tra chính tả, hoặc bấm Không thấy tên tôi.",
      resultsLabel: "Các tên phù hợp",
      inUse: "Đã dùng",
      hostNote: (note: string) => `Ghi chú của người tổ chức: ${note}`,
      guestOf: (playerName: string) => `Khách của ${playerName}`,
      notHere: "Không thấy tên tôi",
      goneNotice:
        "Tên đó không còn trong danh sách. Hãy tìm lại tên của bạn, hoặc nói với người tổ chức.",
      keptNotice:
        "Người tổ chức giữ tên đó trên điện thoại kia. Hãy chọn lại tên của bạn, hoặc nói với người tổ chức.",
      detailsHeading: (name: string) => `Chào ${name}`,
      notYou: "Không phải bạn? Quay lại và chọn tên của bạn.",
      guestIntro: "Cho chúng tôi biết tên của bạn.",
      imHere: "Tôi đã đến",
      chooseAnother: "Chọn tên khác",
      inUseHeading: "Tên này đang được dùng",
      inUseText: (name: string) =>
        `${name} đang được dùng trên một điện thoại khác.`,
      thatsMyName: "Đó là tên tôi",
      hostAskedNote:
        "Người tổ chức sẽ được nhờ chuyển tên sang điện thoại này.",
      transferWaitingTitle: "Đang chờ người tổ chức",
      transferWaitingText: (name: string) =>
        `Bạn đã yêu cầu tên ${name}. Người tổ chức sẽ kiểm tra và chuyển tên sang điện thoại này.`,
      checkedInTitle: (firstName: string) =>
        `Bạn đã vào danh sách, ${firstName}`,
      checkedInText: (sessionName: string) =>
        `Bạn đã điểm danh vào ${sessionName}.`,
      keepOpen:
        "Hãy giữ trang này mở. Người tổ chức sẽ gọi bạn vào sân khi đến lượt.",
      walkInsClosedTitle: "Đã ngừng nhận người chơi ngoài danh sách",
      walkInsClosedText:
        "Hiện chỉ những tên trong danh sách hôm nay mới điểm danh được. Vui lòng nói với người tổ chức.",
    },
    tryAgain: "Thử lại",
  },
  host: hostVi,
  serverMessages: serverMessagesVi,
  engineErrors: engineErrorsVi,
};
