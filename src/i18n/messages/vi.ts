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
    live: {
      readyPill: "Sẵn sàng",
      readyFor: "Bạn đã sẵn sàng được",
      minutes: (minutes: number) => `${minutes} phút`,
      readyText:
        "Chúng tôi sẽ báo trước trận của bạn. Hãy giữ trang này mở, hoặc chú ý người tổ chức gọi.",
      playWithFriend: "Chơi cùng bạn",
      takeBreak: "Nghỉ một lúc",
      leaving: "Tôi về",
      upNextPill: "Trận tiếp theo",
      upNextTitle: (court: string) => `Bạn chơi trận tiếp theo ở ${court}`,
      withAgainst: (partner: string, opponents: string) =>
        `Cùng đội với ${partner}, gặp ${opponents}.`,
      and: "và",
      mayChange: "Có thể thay đổi cho đến khi mọi người xác nhận.",
      imReady: "Tôi sẵn sàng",
      needRest: "Tôi cần nghỉ",
      giveUpTitle: "Nhường chỗ này?",
      giveUpText:
        "Người khác sẽ được mời ngay. Bạn sẽ được nghỉ và giữ nguyên thời gian chờ.",
      keepSpot: "Giữ chỗ của tôi",
      yesRest: "Có, tôi cần nghỉ",
      confirmedPill: "✓ Bạn đã xác nhận",
      waitFor: (court: string) => `Chờ ${court}`,
      gameStillOn: "Trận ở sân đó vẫn đang diễn ra.",
      othersConfirming: "Đang chờ mọi người xác nhận.",
      confirmedLabel: "✓ Đã xác nhận",
      waitingLabel: "Đang chờ",
      emptySpot: "Đang tìm người",
      goPill: "Vào sân",
      headTo: (court: string) => `Vào ${court}`,
      startWhenAll: "Bắt đầu khi đủ bốn người trên sân.",
      gameStarted: "Đã bắt đầu trận",
      changePill: "! Thay đổi",
      pleaseWait: "Vui lòng chờ",
      changeText: (court: string) =>
        `Có người không chơi được. Đang tìm người cho ${court}. Chỗ của bạn vẫn giữ nguyên.`,
      courtChangedPill: "! Đổi sân",
      nowCourt: (court: string) => `Giờ là ${court}`,
      movedText: (from: string, to: string) =>
        `Người tổ chức đã chuyển trận của bạn từ ${from}. Hãy vào ${to}.`,
      playingPill: (minutes: number) => `Đang chơi · ${minutes} phút`,
      tellHost: "Báo người tổ chức khi bạn chơi xong.",
      vs: "gặp",
      you: "Bạn",
      breakPill: "Nghỉ",
      onBreakTitle: (minutes: number) => `Đang nghỉ · ${minutes} phút`,
      pausedTitle: (minutes: number) => `Tạm dừng · ${minutes} phút`,
      pausedText: "Người tổ chức tạm dừng bạn vì bạn chưa trả lời kịp.",
      waitSaved: (minutes: number) =>
        `${minutes} phút chờ của bạn vẫn được giữ.`,
      stillResting: "Vẫn đang nghỉ? Bấm khi bạn muốn chơi.",
      readyAgain: "Tôi sẵn sàng lại",
      leaveTitle: "Về hôm nay?",
      leaveText:
        "Bạn sẽ được đưa ra khỏi danh sách. Nếu quay lại, hãy báo người tổ chức và thời gian chờ sẽ tính lại từ đầu.",
      stay: "Ở lại",
      yesLeave: "Có, tôi về",
      leftTitle: "Bạn đã về",
      leftText: "Cảm ơn bạn đã chơi. Nếu quay lại, hãy báo người tổ chức.",
      endedTitle: "Buổi chơi đã kết thúc",
      endedText: "Cảm ơn bạn đã chơi.",
      updatesItself: "Trang này tự cập nhật.",
      failed: "Chưa thực hiện được. Hãy kiểm tra kết nối và thử lại.",
      changedMeanwhile: "Vừa có thay đổi. Đây là thông tin mới nhất.",
      friend: {
        title: "Chơi cùng bạn",
        explain:
          "Hai bạn sẽ cùng đội trong một trận. Thứ tự của bạn tính theo thời gian chờ ngắn hơn của hai người.",
        searchLabel: "Tên của bạn chơi",
        ask: "Mời",
        genderNote: "Hai nam cần trận toàn nam. Hai nữ cần trận toàn nữ.",
        noMatches:
          "Không có ai đang sẵn sàng trùng tên. Bạn chơi cần đã điểm danh và đang sẵn sàng.",
        back: "Quay lại",
        askedTitle: (name: string) => `${name} muốn chơi cùng đội`,
        askedText: "Cùng đội, chỉ trận tiếp theo.",
        askedWaits: (
          yours: number,
          name: string,
          theirs: number,
          together: number,
        ) =>
          `Bạn đã chờ ${yours} phút và ${name} ${theirs} phút. Hai bạn được tính là ${together} phút.`,
        teamUp: "Cùng đội",
        noThanks: "Không, cảm ơn",
        youAsked: (name: string) => `Đang chờ ${name} đồng ý`,
        teamed: (name: string) => `Đã ghép đội với ${name} cho trận tiếp theo`,
        cancel: "Huỷ",
        droppedOut: (name: string) =>
          `${name} hiện không chơi được. Bạn vẫn giữ chỗ.`,
      },
    },
    tryAgain: "Thử lại",
  },
  host: hostVi,
  serverMessages: serverMessagesVi,
  engineErrors: engineErrorsVi,
};
