import type { engineErrorsEn, serverMessagesEn } from "./serverEn";

// Vietnamese for the host server messages and engine rejections (drafted by
// Claude for native-speaker review). Same terms as hostVi.ts.

export const serverMessagesVi: typeof serverMessagesEn = {
  somethingWentWrong: "Đã xảy ra lỗi. Hãy thử lại sau giây lát.",
  offline: "Không kết nối được máy chủ. Hãy kiểm tra kết nối mạng.",
  access: {
    signedOut: "Phiên đăng nhập đã hết. Hãy đăng nhập lại.",
    notAHost:
      "Bạn không phải người tổ chức ở đây. Hãy nhờ quản lý nhóm gửi lời mời.",
    notAManager: "Chỉ quản lý nhóm mới làm được việc này.",
  },
  setup: {
    draftNotOpen:
      "Bản nháp này không còn mở (đã bị hủy hoặc đã bắt đầu). Hãy tải lại trang.",
    changedElsewhere:
      "Người tổ chức khác, tab khác hoặc thiết bị khác đã thay đổi buổi chơi. Hãy tải lại để xem bản mới nhất — các thay đổi chưa lưu ở đây sẽ mất.",
    liveSessionExists:
      "Nhóm của bạn đang có buổi chơi diễn ra. Hãy kết thúc buổi đó trước khi chuẩn bị buổi mới.",
    checkSessionDetails: "Hãy kiểm tra thông tin buổi chơi rồi thử lại.",
    savedButListNotRefreshed:
      "Đã lưu, nhưng danh sách chưa cập nhật được. Hãy tải lại trang.",
    nameAlreadyInSession: (firstName: string, lastName: string) =>
      `Đã có người tên ${firstName} ${lastName} trong buổi chơi này. Hãy thêm gì đó để phân biệt, ví dụ một chữ cái viết tắt.`,
    waitForAttendance: "Hãy đợi lưu xong danh sách người chơi rồi thử lại.",
    coHostDraft: (draftName: string) =>
      `Một người tổ chức khác đã tạo “${draftName}”. Hai bạn đang cùng chỉnh sửa.`,
  },
  roster: {
    listChanged:
      "Danh sách vừa được người tổ chức khác thay đổi. Hãy kiểm tra lại các tên trước khi thêm.",
    nothingToAdd: "Mọi người trong danh sách dán đã có sẵn.",
    noNames:
      "Không tìm thấy tên nào. Hãy sao chép danh sách trong Reclub rồi dán vào đây.",
    alreadyCheckedIn: "Đã có người điểm danh với tên này.",
    phoneHasOtherName:
      "Điện thoại đó đã điểm danh bằng một tên khác. Hãy hỏi họ tên nào là của họ.",
    sessionClosed: "Buổi chơi này không còn mở.",
    sessionChanged: "Buổi chơi đã thay đổi. Hãy tải lại và thử lại.",
    couldNotSave: "Không lưu được. Hãy kiểm tra kết nối và thử lại.",
  },
  start: {
    reloadSetupAndRetry: "Hãy tải lại trang chuẩn bị rồi thử lại.",
    sessionNotAvailable: "Buổi chơi này không còn. Hãy tải lại trang chuẩn bị.",
    actionIdUsed: "Thao tác này đã được dùng. Hãy tải lại buổi chơi.",
    noLongerDraft:
      "Buổi chơi này không còn là bản nháp. Hãy tải lại trang chuẩn bị.",
    changedElsewhere:
      "Buổi chơi đã thay đổi ở nơi khác. Hãy tải lại trước khi bắt đầu.",
    chooseDoublesCourt: "Hãy chọn ít nhất một sân đánh đôi trước khi bắt đầu.",
    chooseDuration: "Hãy chọn thời lượng từ 1 đến 720 phút.",
    completeDetails:
      "Hãy điền đủ giới tính và trình độ của mọi người chơi trước khi bắt đầu.",
    playersChangedElsewhere:
      "Buổi chơi hoặc người chơi đã thay đổi ở nơi khác. Hãy tải lại trước khi bắt đầu.",
    couldNotStart: "Không bắt đầu được buổi chơi. Hãy tải lại rồi thử lại.",
    unconfirmed:
      "Chưa xác nhận được buổi chơi đã bắt đầu hay chưa. Hãy thử lại cùng thao tác, hoặc tải lại trang.",
  },
  live: {
    couldNotRefresh:
      "Không cập nhật được buổi chơi. Hãy kiểm tra kết nối mạng và thử lại.",
    signInToView:
      "Hãy đăng nhập bằng tài khoản người tổ chức để xem buổi chơi.",
    reloadAndRetry: "Hãy tải lại buổi chơi rồi thử lại.",
    signInToChange:
      "Hãy đăng nhập bằng tài khoản người tổ chức để thay đổi buổi chơi.",
    checkAction: "Hãy kiểm tra thao tác rồi thử lại.",
    sessionNotAvailable: "Buổi chơi này không còn.",
    notSimpleSession:
      "Buổi chơi này không dùng được cách quản lý sân đơn giản.",
    onlyStartOrFinishUndo:
      "Ở đây chỉ hoàn tác được việc bắt đầu hoặc kết thúc trận.",
    actionIdUsed: "Thao tác này đã được dùng. Hãy cập nhật rồi thử lại.",
    groupOrPlayerChanged:
      "Nhóm hoặc người chơi đã thay đổi. Hãy cập nhật trước khi thử lại.",
    updatedByAnotherHost:
      "Người tổ chức khác vừa thay đổi. Hãy xem lại buổi chơi đã cập nhật.",
    couldNotSave:
      "Không lưu được thao tác. Hãy kiểm tra kết nối mạng rồi thử lại.",
    couldNotConfirm:
      "Chưa xác nhận được thao tác. Hãy thử lại để kiểm tra đã lưu hay chưa.",
    waitForSave: "Hãy đợi lưu xong.",
  },
  addPlayer: {
    sessionChanged:
      "Buổi chơi đã thay đổi trước khi lưu. Chưa ai được thêm. Hãy xem lại danh sách rồi thêm lại.",
    checkDetails: "Hãy kiểm tra tên, giới tính và trình độ rồi thử lại.",
    actionIdUsedForOther:
      "Thao tác này đã được dùng cho người chơi khác. Hãy cập nhật rồi thêm lại.",
    notLive: "Buổi chơi chưa diễn ra nên chưa thêm được ai.",
    couldNotConfirm:
      "Chưa xác nhận được người chơi đã được thêm. Hãy thử lại để kiểm tra đã lưu hay chưa.",
  },
  hosts: {
    emailCannotBeInvited:
      "Không mời được email này ở đây. Hãy dùng email khác.",
    fixHighlightedFields: "Hãy sửa các ô được đánh dấu.",
    alreadyAHost: "Người này đã là người tổ chức.",
    alreadyOnList: "Đã có trong danh sách người tổ chức.",
    useDifferentEmail: "Hãy dùng email khác.",
    nowAHost: (displayName: string, email: string) =>
      `${displayName} giờ là người tổ chức. Họ đăng nhập ở trang đăng nhập bằng ${email}.`,
    cannotRemoveSelf: "Bạn không thể tự xóa mình.",
    alreadyRemoved: "Người tổ chức này đã bị xóa.",
    cannotRemoveManager: "Chỉ người vận hành mới xóa được quản lý nhóm.",
    fixHighlightedField: "Hãy sửa ô được đánh dấu.",
    socialRenamed: (socialName: string) => `Tên nhóm giờ là ${socialName}.`,
  },
};

export const engineErrorsVi: typeof engineErrorsEn = {
  POLICY_ACTION_NOT_ALLOWED:
    "Quy tắc của buổi chơi không cho phép thao tác này.",
  SESSION_TIME_UP: "Đã hết giờ chơi: không có nhóm hay trận mới.",
  PLAYER_RESERVED: "Người chơi này đã được gọi vào sân khác.",
  CALLED_GROUP_EXISTS: "Sân này đã có nhóm được gọi.",
  UNKNOWN_CALLED_GROUP: "Nhóm được gọi không còn. Hãy cập nhật trang.",
  SEQ_NOT_INCREASING: "Buổi chơi đã thay đổi. Hãy cập nhật rồi thử lại.",
  TIME_WENT_BACKWARDS: "Đồng hồ buổi chơi bị lệch. Hãy cập nhật trang.",
  MALFORMED_EVENT: "Thao tác không hợp lệ. Hãy cập nhật rồi thử lại.",
  SESSION_NOT_STARTED: "Buổi chơi chưa bắt đầu.",
  SESSION_ALREADY_STARTED: "Buổi chơi đã bắt đầu rồi.",
  SESSION_ENDED: "Buổi chơi đã kết thúc.",
  SESSION_PAUSED: "Buổi chơi đang tạm dừng.",
  SESSION_NOT_PAUSED: "Buổi chơi không tạm dừng.",
  INVALID_CONFIG: "Thiết lập buổi chơi không hợp lệ.",
  DUPLICATE_ID: "Thao tác này đã được dùng. Hãy cập nhật rồi thử lại.",
  UNKNOWN_PARTICIPANT: "Người chơi này không có trong buổi chơi.",
  UNKNOWN_COURT: "Sân này không có trong buổi chơi.",
  UNKNOWN_MATCH: "Trận này không có trong buổi chơi.",
  PLAYER_NOT_PRESENT: "Người chơi này không còn ở đây.",
  PLAYER_ALREADY_PRESENT: "Người chơi này đã có mặt.",
  PLAYER_PLAYING: "Người chơi này đang ở trên sân.",
  PLAYER_SKIPPED: "Người chơi này đang nghỉ.",
  PLAYER_NOT_SKIPPED: "Người chơi này không nghỉ.",
  PLAYER_LOCKED: "Người chơi này đã được giữ cho một sân.",
  PLAYER_NOT_LOCKED: "Người chơi này không được giữ cho sân nào.",
  PLAYER_NOT_IN_MATCH: "Người chơi này không ở trong trận.",
  COURT_CLOSED: "Sân này đang đóng.",
  COURT_NOT_CLOSED: "Sân này không đóng.",
  COURT_BUSY: "Sân này đang có trận.",
  INVALID_TEAMS:
    "Đội không hợp lệ: bốn nam, bốn nữ, hoặc một nam và một nữ mỗi đội.",
  MATCH_NOT_ACTIVE: "Trận này không còn diễn ra.",
  MATCHES_IN_PROGRESS: "Hãy kết thúc các trận trên sân trước.",
  INVALID_QUEUE_ORDER: "Thứ tự hàng chờ không hợp lệ.",
  UNKNOWN_TARGET: "Không tìm thấy thao tác này. Hãy cập nhật trang.",
  TARGET_MISMATCH: "Thao tác hoàn tác không khớp. Hãy cập nhật trang.",
  NOT_REVERSIBLE: "Không hoàn tác được thao tác này.",
  ALREADY_COMPENSATED: "Thao tác này đã được hoàn tác.",
  UNDO_BLOCKED: "Cần hoàn tác thao tác sau trước.",
  MANUAL_ASSIGNMENTS_OFF: "Buổi chơi này đã tắt việc xếp người thủ công.",
  COURT_FULL: "Sân này đã hết chỗ.",
};
