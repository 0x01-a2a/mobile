module.exports = {
  CameraRoll: {
    saveAsset: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
    getPhotos: jest.fn().mockResolvedValue({ edges: [], page_info: {} }),
  },
};
